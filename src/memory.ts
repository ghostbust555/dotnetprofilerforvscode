import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ensureTool } from './tools';
import { DumpObjField, DumpObjResult, GcDumpEntry, HeapObject } from './types';
import { setMemoryContext } from './ai';

let currentHeapDump: string | null = null;

export function getCurrentHeapDump(): string | null {
    return currentHeapDump;
}

export function setCurrentHeapDump(dumpPath: string | null): void {
    currentHeapDump = dumpPath;
}

export function openDumpInTerminal(): void {
    if (!currentHeapDump || !fs.existsSync(currentHeapDump)) {
        vscode.window.showErrorMessage('No heap dump available. Click on a type in the memory snapshot first to create a dump.');
        return;
    }

    const terminal = vscode.window.createTerminal({
        name: 'dotnet-dump analyze',
        cwd: path.dirname(currentHeapDump)
    });

    terminal.show();
    terminal.sendText(`dotnet-dump analyze '${currentHeapDump}'`);
}

export async function takeMemorySnapshot(
    currentProcessId: number | null,
    panel: vscode.WebviewPanel | null
): Promise<void> {
    if (!currentProcessId) {
        vscode.window.showErrorMessage('No process being monitored');
        return;
    }

    if (!await ensureTool('dotnet-gcdump')) {
        return;
    }

    if (!await ensureTool('dotnet-dump')) {
        return;
    }

    panel?.webview.postMessage({ type: 'snapshotStarted', tab: 'memory' });

    // Create a heap dump file for terminal access
    const dumpPath = path.join(os.tmpdir(), `dotnet-heap-${currentProcessId}-${Date.now()}.dump`);

    // Run gcdump report and dump collect in parallel
    const gcdumpProc = spawn('dotnet-gcdump', ['report', '-p', currentProcessId.toString()], { shell: true });
    const dumpProc = spawn('dotnet-dump', ['collect', '-p', currentProcessId.toString(), '--type', 'Heap', '-o', dumpPath], { shell: true });

    let gcdumpOutput = '';

    gcdumpProc.stdout.on('data', (data) => {
        gcdumpOutput += data.toString();
    });

    gcdumpProc.stderr?.on('data', (data) => {
        console.error('gcdump stderr:', data.toString());
    });

    // Track completion of both processes
    let gcdumpDone = false;
    let dumpDone = false;
    let gcdumpSuccess = false;
    let dumpSuccess = false;

    const checkComplete = () => {
        if (!gcdumpDone || !dumpDone) return;

        if (gcdumpSuccess) {
            const results = parseGcDumpOutput(gcdumpOutput);
            setMemoryContext(results);

            // Set the dump path if dump succeeded
            if (dumpSuccess && fs.existsSync(dumpPath)) {
                currentHeapDump = dumpPath;
            }

            panel?.webview.postMessage({
                type: 'memorySnapshot',
                data: results,
                hasDump: dumpSuccess
            });
        } else {
            panel?.webview.postMessage({
                type: 'snapshotError',
                tab: 'memory',
                error: 'Failed to capture memory snapshot'
            });
        }
    };

    gcdumpProc.on('close', (code) => {
        gcdumpDone = true;
        gcdumpSuccess = code === 0;
        checkComplete();
    });

    gcdumpProc.on('error', (err) => {
        gcdumpDone = true;
        gcdumpSuccess = false;
        console.error('gcdump error:', err.message);
        checkComplete();
    });

    dumpProc.on('close', (code) => {
        dumpDone = true;
        dumpSuccess = code === 0;
        checkComplete();
    });

    dumpProc.on('error', (err) => {
        dumpDone = true;
        dumpSuccess = false;
        console.error('dump collect error:', err.message);
        checkComplete();
    });
}

export async function dumpMemoryToFile(
    currentProcessId: number | null,
    panel: vscode.WebviewPanel | null
): Promise<void> {
    if (!currentProcessId) {
        vscode.window.showErrorMessage('No process being monitored');
        return;
    }

    if (!await ensureTool('dotnet-gcdump')) {
        return;
    }

    const defaultName = `gcdump-${currentProcessId}-${Date.now()}.gcdump`;
    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(), defaultName)),
        filters: { 'GC Dump Files': ['gcdump'], 'All Files': ['*'] },
        title: 'Save Memory Dump'
    });

    if (!uri) {
        return;
    }

    panel?.webview.postMessage({ type: 'dumpStarted' });

    const proc = spawn('dotnet-gcdump', ['collect', '-p', currentProcessId.toString(), '-o', uri.fsPath], { shell: true });

    proc.on('close', (code) => {
        if (code === 0) {
            panel?.webview.postMessage({ type: 'dumpComplete', path: uri.fsPath });
            vscode.window.showInformationMessage(`Memory dump saved to ${uri.fsPath}`, 'Open Folder').then(selection => {
                if (selection === 'Open Folder') {
                    vscode.commands.executeCommand('revealFileInOS', uri);
                }
            });
        } else {
            panel?.webview.postMessage({ type: 'dumpError', error: 'Failed to create memory dump' });
            vscode.window.showErrorMessage('Failed to create memory dump');
        }
    });

    proc.on('error', (err) => {
        panel?.webview.postMessage({ type: 'dumpError', error: err.message });
        vscode.window.showErrorMessage(`Failed to create memory dump: ${err.message}`);
    });
}

export async function getTypeRoots(
    typeName: string,
    currentProcessId: number | null,
    panel: vscode.WebviewPanel | null
): Promise<void> {
    if (!currentProcessId) {
        vscode.window.showErrorMessage('No process being monitored');
        return;
    }

    if (!await ensureTool('dotnet-dump')) {
        return;
    }

    panel?.webview.postMessage({ type: 'rootsStarted', typeName });

    if (!currentHeapDump || !fs.existsSync(currentHeapDump)) {
        currentHeapDump = path.join(os.tmpdir(), `dotnet-heap-${currentProcessId}-${Date.now()}.dump`);

        try {
            await new Promise<void>((resolve, reject) => {
                const collectProc = spawn('dotnet-dump', [
                    'collect',
                    '-p', currentProcessId!.toString(),
                    '--type', 'Heap',
                    '-o', currentHeapDump!
                ], { shell: true });

                let stderr = '';
                collectProc.stderr?.on('data', (data) => {
                    stderr += data.toString();
                });

                collectProc.on('close', (code) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(stderr || 'Failed to collect heap dump'));
                    }
                });
                collectProc.on('error', reject);
            });
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'Failed to collect heap dump';
            panel?.webview.postMessage({ type: 'rootsError', error: errorMsg });
            return;
        }
    }

    // Strip any remaining size bucket annotations and escape for shell
    const cleanTypeName = typeName.replace(/\s*\([^)]*Bytes[^)]*\)\s*$/i, '').trim();
    const shellEscapedTypeName = cleanTypeName.replace(/'/g, "'\\''");
    const dumpheapCmd = `dotnet-dump analyze '${currentHeapDump}' -c 'dumpheap -type ${shellEscapedTypeName}' -c exit`;
    const dumpheapProc = spawn(dumpheapCmd, [], { shell: true });

    let dumpheapOutput = '';
    let dumpheapStderr = '';

    dumpheapProc.stdout.on('data', (data) => {
        dumpheapOutput += data.toString();
    });

    dumpheapProc.stderr?.on('data', (data) => {
        dumpheapStderr += data.toString();
    });

    dumpheapProc.on('close', async (code) => {
        if (code !== 0) {
            console.error('dumpheap stderr:', dumpheapStderr);
            console.error('dumpheap stdout:', dumpheapOutput);
            panel?.webview.postMessage({ type: 'rootsError', error: dumpheapStderr || 'Failed to analyze heap' });
            return;
        }

        const addresses = parseHeapAddresses(dumpheapOutput);

        if (addresses.length === 0) {
            panel?.webview.postMessage({ type: 'rootsResult', typeName, roots: [], message: 'No objects found for this type' });
            return;
        }

        const sampleAddresses = addresses.slice(0, 50);

        panel?.webview.postMessage({
            type: 'rootsResult',
            typeName,
            totalObjects: addresses.length,
            dumpPath: currentHeapDump,
            objects: sampleAddresses.map(addr => ({ address: addr.address, size: addr.size }))
        });
    });
}

export async function getObjectDetails(
    dumpPath: string,
    address: string,
    panel: vscode.WebviewPanel | null
): Promise<void> {
    const [dumpObjResult, gcRootResult] = await Promise.all([
        runDumpCommandWithTypeResolution(dumpPath, `dumpobj ${address}`),
        runDumpCommand(dumpPath, `gcroot ${address}`)
    ]);

    panel?.webview.postMessage({
        type: 'objectDetails',
        address,
        dumpPath,
        dumpObj: dumpObjResult,
        gcRoot: gcRootResult
    });
}

function runDumpCommand(dumpPath: string, command: string): Promise<string> {
    return new Promise((resolve) => {
        const cmd = `dotnet-dump analyze '${dumpPath}' -c '${command}' -c exit`;
        const proc = spawn(cmd, [], { shell: true });

        let output = '';

        proc.stdout.on('data', (data) => {
            output += data.toString();
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                resolve('Error: Command failed');
                return;
            }

            const cleanedOutput = cleanDumpOutput(output, command);
            resolve(cleanedOutput);
        });

        proc.on('error', () => {
            resolve('Error: Command failed');
        });
    });
}

async function runDumpCommandWithTypeResolution(dumpPath: string, command: string): Promise<DumpObjResult> {
    return new Promise((resolve) => {
        const cmd = `dotnet-dump analyze '${dumpPath}' -c '${command}' -c exit`;
        const proc = spawn(cmd, [], { shell: true });

        let output = '';

        proc.stdout.on('data', (data) => {
            output += data.toString();
        });

        proc.on('close', async (code) => {
            if (code !== 0) {
                resolve({ header: ['Error: Command failed'], fields: [] });
                return;
            }

            const lines = output.split('\n');
            const cleanedLines: string[] = [];

            for (const line of lines) {
                if (line.includes('Loading core dump') ||
                    line.includes('Ready to process analysis commands') ||
                    line.startsWith('>') ||
                    line.trim() === 'exit') {
                    continue;
                }
                cleanedLines.push(line);
            }

            while (cleanedLines.length > 0 && !cleanedLines[0].trim()) {
                cleanedLines.shift();
            }
            while (cleanedLines.length > 0 && !cleanedLines[cleanedLines.length - 1].trim()) {
                cleanedLines.pop();
            }

            const result = await reformatDumpObjWithTypeResolution(cleanedLines, dumpPath);
            resolve(result);
        });

        proc.on('error', () => {
            resolve({ header: ['Error: Command failed'], fields: [] });
        });
    });
}

function cleanDumpOutput(output: string, command: string): string {
    const lines = output.split('\n');
    const resultLines: string[] = [];

    for (const line of lines) {
        if (line.includes('Loading core dump') ||
            line.includes('Ready to process analysis commands') ||
            line.startsWith('>') ||
            line.trim() === 'exit') {
            continue;
        }
        resultLines.push(line);
    }

    while (resultLines.length > 0 && !resultLines[0].trim()) {
        resultLines.shift();
    }
    while (resultLines.length > 0 && !resultLines[resultLines.length - 1].trim()) {
        resultLines.pop();
    }

    if (command.startsWith('dumpobj')) {
        return reformatDumpObj(resultLines);
    }

    return resultLines.join('\n');
}

function reformatDumpObj(lines: string[]): string {
    const result: string[] = [];
    let inFieldsSection = false;
    const fields: Array<{ mt: string; field: string; offset: string; type: string; vt: string; attr: string; value: string; name: string }> = [];

    for (const line of lines) {
        if (line.trim() === 'Fields:') {
            inFieldsSection = true;
            continue;
        }

        if (inFieldsSection) {
            if (line.includes('MT') && line.includes('Field') && line.includes('Offset') && line.includes('Type')) {
                continue;
            }

            const fieldMatch = line.match(/^([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(.+?)\s+(\d)\s+(static|instance)\s+([0-9a-f]+)\s+(.+)$/i);
            if (fieldMatch) {
                fields.push({
                    mt: fieldMatch[1],
                    field: fieldMatch[2],
                    offset: fieldMatch[3],
                    type: fieldMatch[4].trim(),
                    vt: fieldMatch[5],
                    attr: fieldMatch[6],
                    value: fieldMatch[7],
                    name: fieldMatch[8].trim()
                });
            } else if (line.trim()) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 7) {
                    fields.push({
                        mt: parts[0],
                        field: parts[1],
                        offset: parts[2],
                        type: parts.slice(3, -4).join(' ') || '(unknown)',
                        vt: parts[parts.length - 4],
                        attr: parts[parts.length - 3],
                        value: parts[parts.length - 2],
                        name: parts[parts.length - 1]
                    });
                }
            }
        } else {
            result.push(line);
        }
    }

    if (fields.length > 0) {
        result.push('');
        result.push('Fields:');
        result.push('─'.repeat(80));

        for (const f of fields) {
            result.push(`  ${f.name}`);
            result.push(`    Type:   ${f.type}`);
            result.push(`    Value:  0x${f.value}`);
            result.push(`    Attr:   ${f.attr}, Offset: 0x${f.offset}`);
            result.push('');
        }
    }

    return result.join('\n');
}

async function reformatDumpObjWithTypeResolution(lines: string[], dumpPath: string): Promise<DumpObjResult> {
    const header: string[] = [];
    let inFieldsSection = false;
    const rawFields: Array<{ mt: string; field: string; offset: string; type: string; vt: string; attr: string; value: string; name: string }> = [];

    for (const line of lines) {
        if (line.trim() === 'Fields:') {
            inFieldsSection = true;
            continue;
        }

        if (inFieldsSection) {
            if (line.includes('MT') && line.includes('Field') && line.includes('Offset') && line.includes('Type')) {
                continue;
            }

            const fieldMatch = line.match(/^([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(.+?)\s+(\d)\s+(static|instance)\s+([0-9a-f]+)\s+(.+)$/i);
            if (fieldMatch) {
                rawFields.push({
                    mt: fieldMatch[1],
                    field: fieldMatch[2],
                    offset: fieldMatch[3],
                    type: fieldMatch[4].trim(),
                    vt: fieldMatch[5],
                    attr: fieldMatch[6],
                    value: fieldMatch[7],
                    name: fieldMatch[8].trim()
                });
            } else if (line.trim()) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 7) {
                    rawFields.push({
                        mt: parts[0],
                        field: parts[1],
                        offset: parts[2],
                        type: parts.slice(3, -4).join(' ') || '(unknown)',
                        vt: parts[parts.length - 4],
                        attr: parts[parts.length - 3],
                        value: parts[parts.length - 2],
                        name: parts[parts.length - 1]
                    });
                }
            }
        } else {
            header.push(line);
        }
    }

    const uniqueMTs = new Set<string>();
    for (const f of rawFields) {
        if (f.mt && f.mt !== '0000000000000000' && !f.mt.match(/^0+$/)) {
            uniqueMTs.add(f.mt);
        }
    }

    const mtToType = new Map<string, string>();
    if (uniqueMTs.size > 0) {
        const resolutionPromises = Array.from(uniqueMTs).map(async (mt) => {
            const typeName = await resolveMethodTableType(dumpPath, mt);
            if (typeName) {
                mtToType.set(mt, typeName);
            }
        });
        await Promise.all(resolutionPromises);
    }

    const fields: DumpObjField[] = rawFields.map(f => {
        const resolvedType = mtToType.get(f.mt) || f.type;
        const isStatic = f.attr === 'static';
        const isPrimitive = isPrimitiveType(resolvedType);
        const isReference = !isPrimitive && f.vt === '0' &&
            !f.value.match(/^0+$/) &&
            f.value.match(/^[0-9a-f]+$/i) !== null;
        const displayValue = isPrimitive ? parsePrimitiveValue(resolvedType, f.value) : undefined;

        return {
            name: f.name,
            type: resolvedType,
            value: f.value,
            displayValue,
            isStatic,
            offset: f.offset,
            isReference,
            isPrimitive
        };
    });

    return { header, fields };
}

function isPrimitiveType(typeName: string): boolean {
    const primitives = [
        'System.Boolean', 'System.Byte', 'System.SByte',
        'System.Int16', 'System.UInt16', 'System.Int32', 'System.UInt32',
        'System.Int64', 'System.UInt64', 'System.Single', 'System.Double',
        'System.Char', 'System.IntPtr', 'System.UIntPtr',
        'Boolean', 'Byte', 'SByte', 'Int16', 'UInt16', 'Int32', 'UInt32',
        'Int64', 'UInt64', 'Single', 'Double', 'Char', 'IntPtr', 'UIntPtr'
    ];
    return primitives.includes(typeName);
}

function parsePrimitiveValue(typeName: string, hexValue: string): string {
    try {
        const value = BigInt('0x' + hexValue);

        switch (typeName) {
            case 'System.Boolean':
            case 'Boolean':
                return value === 0n ? 'false' : 'true';

            case 'System.Byte':
            case 'Byte':
                return (Number(value) & 0xFF).toString();

            case 'System.SByte':
            case 'SByte': {
                const byte = Number(value) & 0xFF;
                return (byte > 127 ? byte - 256 : byte).toString();
            }

            case 'System.Int16':
            case 'Int16': {
                const val = Number(value) & 0xFFFF;
                return (val > 32767 ? val - 65536 : val).toString();
            }

            case 'System.UInt16':
            case 'UInt16':
                return (Number(value) & 0xFFFF).toString();

            case 'System.Int32':
            case 'Int32': {
                const val = Number(value) & 0xFFFFFFFF;
                return (val > 2147483647 ? val - 4294967296 : val).toString();
            }

            case 'System.UInt32':
            case 'UInt32':
                return (Number(value) & 0xFFFFFFFF).toString();

            case 'System.Int64':
            case 'Int64': {
                const maxInt64 = BigInt('9223372036854775807');
                if (value > maxInt64) {
                    return (value - BigInt('18446744073709551616')).toString();
                }
                return value.toString();
            }

            case 'System.UInt64':
            case 'UInt64':
                return value.toString();

            case 'System.Single':
            case 'Single': {
                const intVal = Number(value) & 0xFFFFFFFF;
                const buffer = new ArrayBuffer(4);
                new DataView(buffer).setUint32(0, intVal, true);
                return new DataView(buffer).getFloat32(0, true).toString();
            }

            case 'System.Double':
            case 'Double': {
                const buffer = new ArrayBuffer(8);
                new DataView(buffer).setBigUint64(0, value, true);
                return new DataView(buffer).getFloat64(0, true).toString();
            }

            case 'System.Char':
            case 'Char': {
                const charCode = Number(value) & 0xFFFF;
                if (charCode >= 32 && charCode < 127) {
                    return `'${String.fromCharCode(charCode)}'`;
                }
                return `'\\u${charCode.toString(16).padStart(4, '0')}'`;
            }

            case 'System.IntPtr':
            case 'IntPtr':
            case 'System.UIntPtr':
            case 'UIntPtr':
                return '0x' + hexValue;

            default:
                return '0x' + hexValue;
        }
    } catch {
        return '0x' + hexValue;
    }
}

async function resolveMethodTableType(dumpPath: string, mtAddress: string): Promise<string | null> {
    return new Promise((resolve) => {
        const cmd = `dotnet-dump analyze '${dumpPath}' -c 'dumpmt ${mtAddress}' -c exit`;
        const proc = spawn(cmd, [], { shell: true });

        let output = '';

        proc.stdout.on('data', (data) => {
            output += data.toString();
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                resolve(null);
                return;
            }

            const lines = output.split('\n');
            for (const line of lines) {
                const nameMatch = line.match(/^Name:\s+(.+)$/i);
                if (nameMatch) {
                    resolve(nameMatch[1].trim());
                    return;
                }
            }

            resolve(null);
        });

        proc.on('error', () => {
            resolve(null);
        });
    });
}

export function parseHeapAddresses(output: string): HeapObject[] {
    const results: HeapObject[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
        const match = line.match(/^\s*([0-9a-f]+)\s+[0-9a-f]+\s+(\d+)\s*$/i);
        if (match) {
            results.push({
                address: match[1],
                size: parseInt(match[2], 10)
            });
        }
    }

    return results;
}

export function parseGcDumpOutput(output: string): GcDumpEntry[] {
    const typeMap = new Map<string, { count: number; bytes: number }>();
    const lines = output.split('\n');

    let dataStarted = false;
    for (const line of lines) {
        if (line.includes('Object Bytes') && line.includes('Count') && line.includes('Type')) {
            dataStarted = true;
            continue;
        }

        if (!dataStarted) continue;
        if (!line.trim()) continue;

        const match = line.match(/^\s*([\d,]+)\s+([\d,]+)\s+(.+)$/);
        if (match) {
            const bytes = parseInt(match[1].replace(/,/g, ''), 10);
            const count = parseInt(match[2].replace(/,/g, ''), 10);
            let type = match[3].trim();

            // Remove size bucket annotations like "(Bytes > 100K)", "(Bytes >= 1,024)", "(Bytes > 1K)", etc.
            // This pattern is more aggressive to catch all variations
            type = type.replace(/\s*\([^)]*Bytes[^)]*\)\s*$/i, '').trim();

            // Remove assembly annotations like "[System.Private.CoreLib]"
            const assemblyMatch = type.match(/^(.+?)\s*\[[A-Za-z][\w.]*\]$/);
            if (assemblyMatch) {
                type = assemblyMatch[1].trim();
            }

            // Aggregate entries with the same type name (combines size bucket entries)
            const existing = typeMap.get(type);
            if (existing) {
                existing.count += count;
                existing.bytes += bytes;
            } else {
                typeMap.set(type, { count, bytes });
            }
        }
    }

    // Convert map to array
    const results: GcDumpEntry[] = [];
    for (const [type, data] of typeMap) {
        results.push({ type, count: data.count, bytes: data.bytes });
    }

    return results;
}
