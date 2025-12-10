import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let monitoringProcess: ChildProcess | null = null;
let readInterval: ReturnType<typeof setInterval> | null = null;
let outputFile: string | null = null;
let lastFileSize = 0;
let lastEventCount = 0;
let panel: vscode.WebviewPanel | null = null;
let extensionContext: vscode.ExtensionContext;
let currentProcessId: number | null = null;

interface DotNetProcess {
    pid: number;
    name: string;
    commandLine: string;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('DotNet Profiler extension is now active');
    extensionContext = context;

    const startCommand = vscode.commands.registerCommand('dotnet-profiler.startMonitoring', async () => {
        await startMonitoring();
    });

    const stopCommand = vscode.commands.registerCommand('dotnet-profiler.stopMonitoring', () => {
        stopMonitoring();
    });

    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession((session) => {
            if (isDotNetSession(session)) {
                vscode.window.showInformationMessage(
                    'DotNet debug session started. Use "DotNet Profiler: Start Monitoring" to monitor performance.',
                    'Start Monitoring'
                ).then(selection => {
                    if (selection === 'Start Monitoring') {
                        startMonitoring();
                    }
                });
            }
        })
    );

    context.subscriptions.push(
        vscode.debug.onDidTerminateDebugSession((session) => {
            if (isDotNetSession(session)) {
                stopMonitoring();
            }
        })
    );

    context.subscriptions.push(startCommand, stopCommand);
}

function isDotNetSession(session: vscode.DebugSession): boolean {
    return session.type === 'coreclr' || session.type === 'clr' || session.type === 'dotnet';
}

async function isToolInstalled(toolName: string): Promise<boolean> {
    return new Promise((resolve) => {
        const proc = spawn(toolName, ['--version'], { shell: true });
        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
    });
}

async function installTool(toolName: string): Promise<boolean> {
    return new Promise((resolve) => {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Installing ${toolName}...`,
            cancellable: false
        }, async () => {
            const proc = spawn('dotnet', ['tool', 'install', '--global', toolName], { shell: true });

            let stderr = '';
            proc.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            return new Promise<void>((resolveProgress) => {
                proc.on('close', (code) => {
                    resolveProgress();
                    if (code === 0) {
                        vscode.window.showInformationMessage(`${toolName} installed successfully!`);
                        resolve(true);
                    } else {
                        if (stderr.includes('already installed')) {
                            resolve(true);
                        } else {
                            vscode.window.showErrorMessage(`Failed to install ${toolName}: ${stderr}`);
                            resolve(false);
                        }
                    }
                });
                proc.on('error', (err) => {
                    resolveProgress();
                    vscode.window.showErrorMessage(`Failed to install ${toolName}: ${err.message}`);
                    resolve(false);
                });
            });
        });
    });
}

async function ensureTool(toolName: string): Promise<boolean> {
    if (await isToolInstalled(toolName)) {
        return true;
    }

    const choice = await vscode.window.showWarningMessage(
        `${toolName} is not installed. Would you like to install it now?`,
        'Install',
        'Cancel'
    );

    if (choice === 'Install') {
        return await installTool(toolName);
    }

    return false;
}

async function listDotNetProcesses(): Promise<DotNetProcess[]> {
    return new Promise((resolve) => {
        const proc = spawn('dotnet-counters', ['ps'], { shell: true });
        let output = '';

        proc.stdout.on('data', (data) => {
            output += data.toString();
        });

        proc.on('close', () => {
            const processes: DotNetProcess[] = [];
            const lines = output.split('\n');

            for (const line of lines) {
                if (!line.trim()) continue;

                const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)/);
                if (match) {
                    processes.push({
                        pid: parseInt(match[1], 10),
                        name: match[2],
                        commandLine: match[3].trim()
                    });
                }
            }

            resolve(processes);
        });

        proc.on('error', () => resolve([]));
    });
}

async function findProcessByWorkspacePath(): Promise<number | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return null;
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;
    const processes = await listDotNetProcesses();

    const userProcesses = processes.filter(p =>
        !p.commandLine.includes('.vscode/extensions') &&
        !p.commandLine.includes('.vscode\\extensions') &&
        !p.commandLine.includes('MSBuild.dll') &&
        !p.commandLine.includes('vstest.console.dll') &&
        !p.name.includes('dotnet-counters') &&
        !p.name.includes('dotnet-trace') &&
        !p.name.includes('dotnet-gcdump')
    );

    const matchingProcesses = userProcesses.filter(p =>
        p.commandLine.includes(workspacePath)
    );

    if (matchingProcesses.length === 1) {
        return matchingProcesses[0].pid;
    } else if (matchingProcesses.length > 1) {
        return selectFromProcessList(matchingProcesses);
    }

    return null;
}

async function selectFromProcessList(processes: DotNetProcess[]): Promise<number | null> {
    if (processes.length === 0) {
        vscode.window.showErrorMessage('No .NET processes found.');
        return null;
    }

    const items = processes.map(p => ({
        label: `${p.pid}: ${p.name}`,
        description: p.commandLine.length > 80
            ? p.commandLine.substring(0, 80) + '...'
            : p.commandLine,
        detail: p.commandLine,
        pid: p.pid
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a .NET process to monitor',
        matchOnDescription: true,
        matchOnDetail: true
    });

    return selected ? selected.pid : null;
}

async function getDebuggedProcessId(): Promise<number | null> {
    const session = vscode.debug.activeDebugSession;

    if (session && isDotNetSession(session)) {
        const config = session.configuration;
        if (config.processId && typeof config.processId === 'number') {
            return config.processId;
        }
    }

    const pidByWorkspace = await findProcessByWorkspacePath();
    if (pidByWorkspace) {
        return pidByWorkspace;
    }

    const allProcesses = await listDotNetProcesses();
    const userProcesses = allProcesses.filter(p =>
        !p.commandLine.includes('.vscode/extensions') &&
        !p.commandLine.includes('.vscode\\extensions') &&
        !p.commandLine.includes('MSBuild.dll') &&
        !p.commandLine.includes('vstest.console.dll') &&
        !p.name.includes('dotnet-counters') &&
        !p.name.includes('dotnet-trace') &&
        !p.name.includes('dotnet-gcdump')
    );

    if (userProcesses.length === 0) {
        vscode.window.showErrorMessage('No .NET processes found. Make sure your application is running.');
        return null;
    }

    return selectFromProcessList(userProcesses);
}

function createWebviewPanel(processId: number): vscode.WebviewPanel {
    const newPanel = vscode.window.createWebviewPanel(
        'dotnetProfiler',
        `DotNet Profiler - PID ${processId}`,
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    newPanel.webview.html = getWebviewContent();

    newPanel.webview.onDidReceiveMessage(
        async (message) => {
            switch (message.command) {
                case 'takeMemorySnapshot':
                    await takeMemorySnapshot();
                    break;
                case 'takeCpuTrace':
                    await takeCpuTrace(message.duration || 5);
                    break;
                case 'dumpMemoryToFile':
                    await dumpMemoryToFile();
                    break;
                case 'getTypeRoots':
                    await getTypeRoots(message.typeName);
                    break;
                case 'getObjectDetails':
                    await getObjectDetails(message.dumpPath, message.address);
                    break;
                case 'openInSpeedscope':
                    await openInSpeedscope();
                    break;
            }
        },
        undefined,
        extensionContext.subscriptions
    );

    newPanel.onDidDispose(() => {
        panel = null;
        stopMonitoring();
    }, null, extensionContext.subscriptions);

    return newPanel;
}

async function takeMemorySnapshot(): Promise<void> {
    if (!currentProcessId) {
        vscode.window.showErrorMessage('No process being monitored');
        return;
    }

    if (!await ensureTool('dotnet-gcdump')) {
        return;
    }

    panel?.webview.postMessage({ type: 'snapshotStarted', tab: 'memory' });

    const proc = spawn('dotnet-gcdump', ['report', '-p', currentProcessId.toString()], { shell: true });
    let output = '';

    proc.stdout.on('data', (data) => {
        output += data.toString();
    });

    proc.stderr?.on('data', (data) => {
        console.error('gcdump stderr:', data.toString());
    });

    proc.on('close', (code) => {
        if (code === 0) {
            const results = parseGcDumpOutput(output);
            panel?.webview.postMessage({
                type: 'memorySnapshot',
                data: results
            });
        } else {
            panel?.webview.postMessage({
                type: 'snapshotError',
                tab: 'memory',
                error: 'Failed to capture memory snapshot'
            });
        }
    });

    proc.on('error', (err) => {
        panel?.webview.postMessage({
            type: 'snapshotError',
            tab: 'memory',
            error: err.message
        });
    });
}

async function dumpMemoryToFile(): Promise<void> {
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

let currentHeapDump: string | null = null;
let currentTraceFile: string | null = null;

async function getTypeRoots(typeName: string): Promise<void> {
    if (!currentProcessId) {
        vscode.window.showErrorMessage('No process being monitored');
        return;
    }

    if (!await ensureTool('dotnet-dump')) {
        return;
    }

    panel?.webview.postMessage({ type: 'rootsStarted', typeName });

    // Collect a heap dump if we don't have one
    if (!currentHeapDump || !fs.existsSync(currentHeapDump)) {
        currentHeapDump = path.join(os.tmpdir(), `dotnet-heap-${currentProcessId}-${Date.now()}.dump`);

        try {
            await new Promise<void>((resolve, reject) => {
                // Use shell: true to inherit PATH with dotnet tools
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

    // Get objects of this type using dumpheap
    // Escape the type name for shell: escape single quotes and wrap in single quotes
    const shellEscapedTypeName = typeName.replace(/'/g, "'\\''");
    // Use a single command string to avoid shell argument splitting issues
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

        // Parse object addresses from dumpheap output
        const addresses = parseHeapAddresses(dumpheapOutput);

        if (addresses.length === 0) {
            panel?.webview.postMessage({ type: 'rootsResult', typeName, roots: [], message: 'No objects found for this type' });
            return;
        }

        // Send addresses to the UI (up to 50) - details loaded lazily on expand
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

function parseHeapAddresses(output: string): Array<{ address: string; size: number }> {
    const results: Array<{ address: string; size: number }> = [];
    const lines = output.split('\n');

    for (const line of lines) {
        // Parse lines like: "    7f8d02378060     7fcd1a1fbe30             58"
        // Format: address, MT, size
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

interface DumpObjField {
    name: string;
    type: string;
    value: string;
    isStatic: boolean;
    offset: string;
    isReference: boolean; // true if this is a reference type that can be clicked
}

interface DumpObjResult {
    header: string[];
    fields: DumpObjField[];
}

async function getObjectDetails(dumpPath: string, address: string): Promise<void> {
    // Run both dumpobj and gcroot in parallel
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

            // Clean output and extract MT addresses that need resolution
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

            // Trim empty lines from start and end
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
        // Skip loading messages, prompts, and empty lines at start/end
        if (line.includes('Loading core dump') ||
            line.includes('Ready to process analysis commands') ||
            line.startsWith('>') ||
            line.trim() === 'exit') {
            continue;
        }
        resultLines.push(line);
    }

    // Trim empty lines from start and end
    while (resultLines.length > 0 && !resultLines[0].trim()) {
        resultLines.shift();
    }
    while (resultLines.length > 0 && !resultLines[resultLines.length - 1].trim()) {
        resultLines.pop();
    }

    // For dumpobj, reformat the Fields section to be more readable
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
            // Skip the header line
            if (line.includes('MT') && line.includes('Field') && line.includes('Offset') && line.includes('Type')) {
                continue;
            }

            // Parse field lines - they have fixed positions but we need to handle variable content
            // Format: MT Field Offset Type VT Attr Value Name
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
                // Try alternative parsing for lines where type might be truncated or empty
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

    // If we found fields, format them nicely
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
            // Skip the header line
            if (line.includes('MT') && line.includes('Field') && line.includes('Offset') && line.includes('Type')) {
                continue;
            }

            // Parse field lines - they have fixed positions but we need to handle variable content
            // Format: MT Field Offset Type VT Attr Value Name
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
                // Try alternative parsing for lines where type might be truncated or empty
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

    // Resolve MT addresses to full type names
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

    // Build structured fields
    const fields: DumpObjField[] = rawFields.map(f => {
        const resolvedType = mtToType.get(f.mt) || f.type;
        const isStatic = f.attr === 'static';
        // A field is a clickable reference if:
        // 1. It's not a value type (vt === '0')
        // 2. The value is not null (not all zeros)
        // 3. The value looks like a valid address
        const isReference = f.vt === '0' &&
            !f.value.match(/^0+$/) &&
            f.value.match(/^[0-9a-f]+$/i) !== null;

        return {
            name: f.name,
            type: resolvedType,
            value: f.value,
            isStatic,
            offset: f.offset,
            isReference
        };
    });

    return { header, fields };
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

            // Parse dumpmt output to find the Name line
            // Example output:
            // EEClass:         00007f9a12345678
            // Module:          00007f9a12345678
            // Name:            System.Collections.Generic.Dictionary`2[[System.String, System.Private.CoreLib],[System.Object, System.Private.CoreLib]]
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

function parseGcDumpOutput(output: string): Array<{ type: string; count: number; bytes: number }> {
    const results: Array<{ type: string; count: number; bytes: number }> = [];
    const lines = output.split('\n');

    // Skip header lines until we find the data
    let dataStarted = false;
    for (const line of lines) {
        if (line.includes('Object Bytes') && line.includes('Count') && line.includes('Type')) {
            dataStarted = true;
            continue;
        }

        if (!dataStarted) continue;
        if (!line.trim()) continue;

        // Parse lines like: "      1,396,088         3  Entry<...>[]"
        const match = line.match(/^\s*([\d,]+)\s+([\d,]+)\s+(.+)$/);
        if (match) {
            const bytes = parseInt(match[1].replace(/,/g, ''), 10);
            const count = parseInt(match[2].replace(/,/g, ''), 10);
            let type = match[3].trim();

            // Clean up type name - remove annotations like "(Bytes > 1K)" or "(Bytes > 85000)"
            type = type.replace(/\s*\(Bytes\s*[><=]+\s*[\dKMGB,]+\)\s*$/i, '').trim();

            // Remove assembly info in brackets at the end like [System.Private.CoreLib]
            const assemblyMatch = type.match(/^(.+?)\s*\[[A-Za-z][\w.]*\]$/);
            if (assemblyMatch) {
                type = assemblyMatch[1].trim();
            }

            results.push({ type, count, bytes });
        }
    }

    return results;
}

async function takeCpuTrace(durationSeconds: number): Promise<void> {
    if (!currentProcessId) {
        vscode.window.showErrorMessage('No process being monitored');
        return;
    }

    if (!await ensureTool('dotnet-trace')) {
        return;
    }

    panel?.webview.postMessage({ type: 'snapshotStarted', tab: 'cpu' });

    // Clean up previous trace file
    if (currentTraceFile && fs.existsSync(currentTraceFile)) {
        try { fs.unlinkSync(currentTraceFile); } catch { /* ignore */ }
    }

    const traceFile = path.join(os.tmpdir(), `dotnet-trace-${currentProcessId}-${Date.now()}.nettrace`);

    // Collect trace for specified duration
    const collectProc = spawn('dotnet-trace', [
        'collect',
        '-p', currentProcessId.toString(),
        '--duration', `00:00:${durationSeconds.toString().padStart(2, '0')}`,
        '-o', traceFile,
        '--profile', 'cpu-sampling'
    ], { shell: true });

    collectProc.on('close', async (code) => {
        if (code === 0 && fs.existsSync(traceFile)) {
            currentTraceFile = traceFile;

            // Generate report from trace file
            const reportProc = spawn('dotnet-trace', ['report', traceFile, 'topN', '-n', '50', '--inclusive'], { shell: true });
            let reportOutput = '';

            reportProc.stdout.on('data', (data) => {
                reportOutput += data.toString();
            });

            reportProc.on('close', (reportCode) => {
                if (reportCode === 0) {
                    const results = parseCpuTraceOutput(reportOutput);
                    panel?.webview.postMessage({
                        type: 'cpuTrace',
                        data: results,
                        hasTraceFile: true
                    });
                } else {
                    panel?.webview.postMessage({
                        type: 'snapshotError',
                        tab: 'cpu',
                        error: 'Failed to generate CPU report'
                    });
                }
            });
        } else {
            panel?.webview.postMessage({
                type: 'snapshotError',
                tab: 'cpu',
                error: 'Failed to collect CPU trace'
            });
        }
    });

    collectProc.on('error', (err) => {
        panel?.webview.postMessage({
            type: 'snapshotError',
            tab: 'cpu',
            error: err.message
        });
    });
}

async function openInSpeedscope(): Promise<void> {
    if (!currentTraceFile || !fs.existsSync(currentTraceFile)) {
        vscode.window.showErrorMessage('No trace file available. Take a CPU trace first.');
        return;
    }

    // Check if speedscope is installed
    const isSpeedscopeInstalled = await new Promise<boolean>((resolve) => {
        const proc = spawn('speedscope', ['--version'], { shell: true });
        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
    });

    if (!isSpeedscopeInstalled) {
        const choice = await vscode.window.showWarningMessage(
            'speedscope is not installed. Would you like to install it now?',
            'Install',
            'Cancel'
        );

        if (choice !== 'Install') {
            return;
        }

        // Install speedscope globally
        const installed = await new Promise<boolean>((resolve) => {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Installing speedscope...',
                cancellable: false
            }, async () => {
                const installProc = spawn('npm', ['install', '-g', 'speedscope'], { shell: true });

                let stderr = '';
                installProc.stderr?.on('data', (data) => {
                    stderr += data.toString();
                });

                return new Promise<void>((resolveProgress) => {
                    installProc.on('close', (code) => {
                        resolveProgress();
                        if (code === 0) {
                            vscode.window.showInformationMessage('speedscope installed successfully!');
                            resolve(true);
                        } else {
                            vscode.window.showErrorMessage(`Failed to install speedscope: ${stderr}`);
                            resolve(false);
                        }
                    });
                    installProc.on('error', (err) => {
                        resolveProgress();
                        vscode.window.showErrorMessage(`Failed to install speedscope: ${err.message}`);
                        resolve(false);
                    });
                });
            });
        });

        if (!installed) {
            return;
        }
    }

    // Convert .nettrace to speedscope format using dotnet-trace
    // dotnet-trace convert adds .speedscope.json extension automatically
    const speedscopeOutputBase = currentTraceFile.replace('.nettrace', '');
    const speedscopeFile = speedscopeOutputBase + '.speedscope.json';

    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Converting trace to speedscope format...',
        cancellable: false
    }, async () => {
        return new Promise<void>((resolve) => {
            let stderr = '';
            let stdout = '';
            const convertProc = spawn('dotnet-trace', [
                'convert',
                currentTraceFile!,
                '--format', 'Speedscope',
                '-o', speedscopeOutputBase
            ], { shell: true });

            convertProc.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            convertProc.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            convertProc.on('close', (code) => {
                resolve();
                if (code === 0 && fs.existsSync(speedscopeFile)) {
                    launchSpeedscope(speedscopeFile);
                } else {
                    // Check for file with different naming convention
                    const altFile = currentTraceFile!.replace('.nettrace', '.speedscope.json');
                    if (fs.existsSync(altFile)) {
                        launchSpeedscope(altFile);
                    } else {
                        const errMsg = stderr || stdout || `Exit code: ${code}`;
                        vscode.window.showErrorMessage(`Failed to convert trace: ${errMsg}`);
                    }
                }
            });

            convertProc.on('error', (err) => {
                resolve();
                vscode.window.showErrorMessage(`Failed to convert trace: ${err.message}`);
            });
        });
    });
}

function launchSpeedscope(filePath: string): void {
    const openProc = spawn('speedscope', [filePath], {
        shell: true,
        detached: true
    });

    let speedscopeOutput = '';

    openProc.stdout?.on('data', (data) => {
        speedscopeOutput += data.toString();
        // Check for URL as soon as we get output
        checkForUrl();
    });

    openProc.stderr?.on('data', (data) => {
        speedscopeOutput += data.toString();
        checkForUrl();
    });

    let urlSent = false;
    function checkForUrl() {
        if (urlSent) return;
        const urlMatch = speedscopeOutput.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
            urlSent = true;
            const url = urlMatch[0];

            // Send URL to webview for copy button
            panel?.webview.postMessage({
                type: 'speedscopeUrl',
                url: url,
                filePath: filePath
            });

            vscode.window.showInformationMessage(`Speedscope: ${url}`, 'Copy URL').then(selection => {
                if (selection === 'Copy URL') {
                    vscode.env.clipboard.writeText(url);
                    vscode.window.showInformationMessage('URL copied to clipboard');
                }
            });
        }
    }

    openProc.unref();
}

function parseCpuTraceOutput(output: string): Array<{ function: string; inclusivePercent: number; exclusivePercent: number }> {
    const results: Array<{ function: string; inclusivePercent: number; exclusivePercent: number }> = [];
    const lines = output.split('\n');

    for (const line of lines) {
        // Parse lines like: "1.  PortableThreadPool+WorkerThread.WorkerThreadStart()       33.33%              0%"
        // Format: number. function_name    inclusive%    exclusive%
        const match = line.match(/^\d+\.\s+(.+?)\s{2,}([\d.]+)%\s+([\d.]+)%/);
        if (match) {
            const funcName = match[1].trim();
            // Skip non-useful entries
            if (funcName === '(Non-Activities)' || funcName === 'Threads') {
                continue;
            }
            results.push({
                function: funcName,
                inclusivePercent: parseFloat(match[2]),
                exclusivePercent: parseFloat(match[3])
            });
        }
    }

    return results;
}

function getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DotNet Profiler</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body {
            height: 100%;
            font-family: var(--vscode-font-family, sans-serif);
            background: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-editor-foreground, #d4d4d4);
        }
        body {
            padding: 16px;
            display: flex;
            flex-direction: column;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
        }
        h1 { font-size: 1.3em; }
        .zoom-controls {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .btn {
            background: var(--vscode-button-secondaryBackground, #3c3c3c);
            color: var(--vscode-button-secondaryForeground, #d4d4d4);
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 4px;
            padding: 4px 12px;
            cursor: pointer;
            font-size: 13px;
        }
        .btn:hover { background: var(--vscode-button-secondaryHoverBackground, #505050); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-primary {
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #ffffff);
        }
        .btn-primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
        .zoom-label { font-size: 0.85em; color: #888; min-width: 60px; text-align: center; }
        .stats {
            display: flex;
            gap: 12px;
            margin-bottom: 16px;
            flex-wrap: wrap;
        }
        .stat-card {
            background: var(--vscode-input-background, #3c3c3c);
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 4px;
            padding: 12px 20px;
            text-align: center;
            min-width: 120px;
        }
        .stat-value { font-size: 1.6em; font-weight: bold; }
        .stat-value.cpu { color: #4fc3f7; }
        .stat-value.memory { color: #81c784; }
        .stat-value.gc { color: #ffb74d; }
        .stat-label { font-size: 0.8em; color: #888; margin-top: 4px; }
        .chart-container {
            background: var(--vscode-input-background, #252526);
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 4px;
            padding: 12px;
            margin-bottom: 16px;
        }
        .chart-title { font-size: 0.95em; margin-bottom: 8px; }
        .chart { height: 150px; position: relative; }
        canvas { display: block; }

        /* Tabs */
        .tabs-container {
            margin-top: 20px;
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 4px;
            overflow: hidden;
            flex: 1;
            display: flex;
            flex-direction: column;
            min-height: 0;
        }
        .tabs-header {
            display: flex;
            background: var(--vscode-editor-background, #1e1e1e);
            border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
        }
        .tab-btn {
            flex: 1;
            padding: 10px 16px;
            background: transparent;
            border: none;
            color: var(--vscode-foreground, #d4d4d4);
            cursor: pointer;
            font-size: 13px;
            border-bottom: 2px solid transparent;
        }
        .tab-btn:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
        .tab-btn.active {
            border-bottom-color: var(--vscode-focusBorder, #007fd4);
            background: var(--vscode-input-background, #3c3c3c);
        }
        .tab-content {
            display: none;
            padding: 16px;
            background: var(--vscode-input-background, #252526);
            flex: 1;
            min-height: 0;
            overflow: hidden;
            flex-direction: column;
        }
        .tab-content.active { display: flex; }

        /* Snapshot controls */
        .snapshot-controls {
            display: flex;
            gap: 10px;
            align-items: center;
            margin-bottom: 16px;
        }
        .snapshot-controls select {
            padding: 4px 8px;
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--vscode-input-foreground, #d4d4d4);
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 4px;
        }
        .snapshot-controls input[type="text"] {
            flex: 1;
            min-width: 0;
            padding: 6px 10px;
            background: #1a1a1a;
            color: var(--vscode-input-foreground, #d4d4d4);
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 4px;
        }
        .snapshot-controls input[type="text"]::placeholder {
            color: var(--vscode-input-placeholderForeground, #888);
        }
        .btn-secondary {
            background: #1a1a1a;
            border: 1px solid var(--vscode-panel-border, #555);
        }
        .btn-secondary:hover {
            background: #2a2a2a;
        }
        .btn-copy-url {
            padding: 4px 8px;
            min-width: auto;
            font-size: 14px;
        }

        /* Data grid */
        .data-grid {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
            table-layout: fixed;
        }
        .data-grid th, .data-grid td {
            padding: 8px 12px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
        }
        .data-grid th {
            background: var(--vscode-editor-background, #1e1e1e);
            font-weight: 600;
            position: sticky;
            top: 0;
            cursor: pointer;
        }
        .data-grid th:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
        .data-grid tr:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
        .data-grid .num { text-align: right; font-family: monospace; white-space: nowrap; width: 100px; }
        .data-grid .type-col { word-break: break-all; }
        .data-grid .func-col { word-break: break-all; }
        .data-grid .type-col.clickable {
            color: var(--vscode-textLink-foreground, #3794ff);
            cursor: pointer;
        }
        .data-grid .type-col.clickable:hover {
            text-decoration: underline;
        }

        /* Object details panel */
        .objects-panel {
            margin-top: 16px;
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 4px;
            background: var(--vscode-editor-background, #1e1e1e);
            flex: 1;
            min-height: 75%;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }
        .objects-panel-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 12px;
            background: var(--vscode-input-background, #3c3c3c);
            border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
        }
        .objects-panel-header h3 {
            font-size: 13px;
            font-weight: 600;
            margin: 0;
        }
        .objects-panel-close {
            background: none;
            border: none;
            color: var(--vscode-foreground, #d4d4d4);
            cursor: pointer;
            font-size: 16px;
            padding: 0 4px;
        }
        .objects-panel-close:hover {
            color: var(--vscode-errorForeground, #f44336);
        }
        .objects-panel-content {
            padding: 8px;
            overflow-y: auto;
            flex: 1;
            font-family: monospace;
            font-size: 11px;
        }
        .object-item {
            margin-bottom: 4px;
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 4px;
        }
        .object-header {
            display: flex;
            align-items: center;
            padding: 6px 10px;
            background: var(--vscode-input-background, #3c3c3c);
            cursor: pointer;
            user-select: none;
        }
        .object-header:hover {
            background: var(--vscode-list-hoverBackground, #2a2d2e);
        }
        .object-toggle {
            margin-right: 8px;
            font-size: 10px;
            color: #888;
            transition: transform 0.2s;
        }
        .object-item.expanded .object-toggle {
            transform: rotate(90deg);
        }
        .object-address {
            color: var(--vscode-textLink-foreground, #3794ff);
        }
        .object-size {
            color: #888;
            margin-left: 8px;
        }
        .object-details {
            display: none;
            background: var(--vscode-editor-background, #1e1e1e);
            border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
        }
        .object-item.expanded .object-details {
            display: block;
        }
        .object-tabs {
            display: flex;
            background: var(--vscode-input-background, #3c3c3c);
            border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
        }
        .object-tab {
            padding: 4px 12px;
            cursor: pointer;
            font-size: 11px;
            border: none;
            background: transparent;
            color: var(--vscode-foreground, #d4d4d4);
            border-bottom: 2px solid transparent;
        }
        .object-tab:hover {
            background: var(--vscode-list-hoverBackground, #2a2d2e);
        }
        .object-tab.active {
            border-bottom-color: var(--vscode-focusBorder, #007fd4);
        }
        .object-tab-content {
            display: none;
            padding: 8px 10px;
            white-space: pre-wrap;
            word-break: break-all;
            max-height: 250px;
            overflow-y: auto;
        }
        .object-tab-content.active {
            display: block;
        }
        .object-tab-loading {
            color: #888;
            display: flex;
            align-items: center;
            padding: 12px;
        }
        .object-tab-loading::after {
            content: '';
            width: 12px;
            height: 12px;
            border: 2px solid #888;
            border-top-color: transparent;
            border-radius: 50%;
            margin-left: 8px;
            animation: spin 1s linear infinite;
        }
        .objects-loading {
            color: #888;
            display: flex;
            align-items: center;
            padding: 12px;
        }
        .objects-loading::after {
            content: '';
            width: 14px;
            height: 14px;
            border: 2px solid #888;
            border-top-color: transparent;
            border-radius: 50%;
            margin-left: 8px;
            animation: spin 1s linear infinite;
        }
        .objects-empty {
            color: #888;
            font-style: italic;
            padding: 12px;
        }

        /* Field styles for class-definition format */
        .fields-list {
            font-family: monospace;
            font-size: 11px;
            line-height: 1.6;
        }
        .field-line {
            padding: 2px 0;
        }
        .field-static {
            color: #569cd6;
        }
        .field-type {
            color: #4ec9b0;
        }
        .field-name {
            color: #9cdcfe;
        }
        .field-ref {
            color: var(--vscode-textLink-foreground, #3794ff);
            cursor: pointer;
            text-decoration: underline;
        }
        .field-ref:hover {
            color: #5dade2;
        }
        .field-value {
            color: #888;
        }
        .field-offset {
            color: #666;
            font-size: 10px;
        }

        /* Nested object styles */
        .nested-object {
            margin: 4px 0 4px 20px;
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 4px;
            background: var(--vscode-editor-background, #1e1e1e);
        }
        .nested-object-header {
            display: flex;
            align-items: center;
            padding: 4px 8px;
            background: var(--vscode-input-background, #3c3c3c);
            cursor: pointer;
            user-select: none;
            font-size: 11px;
        }
        .nested-object-header:hover {
            background: var(--vscode-list-hoverBackground, #2a2d2e);
        }
        .nested-object-header .object-toggle {
            margin-right: 6px;
            font-size: 9px;
            color: #888;
            transition: transform 0.2s;
        }
        .nested-object.expanded .nested-object-header .object-toggle {
            transform: rotate(90deg);
        }
        .nested-object-details {
            display: none;
            border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
        }
        .nested-object.expanded .nested-object-details {
            display: block;
        }

        .grid-container {
            flex: 1;
            overflow-y: auto;
            min-height: 0;
        }
        .loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 40px;
            color: #888;
        }
        .loading::after {
            content: '';
            width: 20px;
            height: 20px;
            border: 2px solid #888;
            border-top-color: transparent;
            border-radius: 50%;
            margin-left: 10px;
            animation: spin 1s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .empty-state {
            text-align: center;
            padding: 40px;
            color: #888;
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #memoryGridContainer, #cpuGridContainer {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-height: 0;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>DotNet Process Monitor</h1>
        <div class="zoom-controls">
            <button class="btn" id="zoomIn" title="Zoom In (30s)">+</button>
            <span class="zoom-label" id="zoomLabel">1 min</span>
            <button class="btn" id="zoomOut" title="Zoom Out (5min)">-</button>
        </div>
    </div>

    <div class="stats">
        <div class="stat-card">
            <div class="stat-value cpu" id="cpuValue">0%</div>
            <div class="stat-label">CPU Usage</div>
        </div>
        <div class="stat-card">
            <div class="stat-value memory" id="memoryValue">0 MB</div>
            <div class="stat-label">Working Set</div>
        </div>
        <div class="stat-card">
            <div class="stat-value gc" id="gcHeapValue">0 MB</div>
            <div class="stat-label">GC Heap</div>
        </div>
    </div>

    <div class="chart-container">
        <div class="chart-title">CPU Usage (%)</div>
        <div class="chart"><canvas id="cpuChart"></canvas></div>
    </div>

    <div class="chart-container">
        <div class="chart-title">Memory (MB)</div>
        <div class="chart"><canvas id="memoryChart"></canvas></div>
    </div>

    <div class="tabs-container">
        <div class="tabs-header">
            <button class="tab-btn active" data-tab="memory">Memory</button>
            <button class="tab-btn" data-tab="cpu">CPU</button>
        </div>

        <div class="tab-content active" id="tab-memory">
            <div class="snapshot-controls">
                <button class="btn btn-primary" id="takeMemorySnapshot">Take Memory Snapshot</button>
                <button class="btn btn-secondary" id="dumpMemoryToFile">Dump Memory To File</button>
                <input type="text" id="memoryFilter" placeholder="Filter types..." />
            </div>
            <div id="memoryGridContainer">
                <div class="empty-state">Click "Take Memory Snapshot" to analyze heap allocations</div>
            </div>
            <div id="objectsPanel" class="objects-panel" style="display: none;">
                <div class="objects-panel-header">
                    <h3 id="objectsPanelTitle">Objects</h3>
                    <button class="objects-panel-close" id="closeObjectsPanel">&times;</button>
                </div>
                <div class="objects-panel-content" id="objectsPanelContent"></div>
            </div>
        </div>

        <div class="tab-content" id="tab-cpu">
            <div class="snapshot-controls">
                <button class="btn btn-primary" id="takeCpuTrace">Take CPU Trace</button>
                <label>Duration:
                    <select id="traceDuration">
                        <option value="3">3 sec</option>
                        <option value="5" selected>5 sec</option>
                        <option value="10">10 sec</option>
                        <option value="30">30 sec</option>
                    </select>
                </label>
                <button class="btn btn-secondary" id="openSpeedscope" disabled>Open in Speedscope</button>
                <button class="btn btn-secondary btn-copy-url" id="copySpeedscopeUrl" style="display:none;" title="Copy Speedscope URL">&#128279;</button>
                <input type="text" id="cpuFilter" placeholder="Filter functions..." />
            </div>
            <div id="cpuGridContainer">
                <div class="empty-state">Click "Take CPU Trace" to analyze CPU usage by function</div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        // Zoom levels
        const zoomLevels = [
            { points: 30, label: '30 sec' },
            { points: 60, label: '1 min' },
            { points: 300, label: '5 min' }
        ];
        let currentZoom = 1;
        let maxPoints = zoomLevels[currentZoom].points;

        const allCpuHistory = [];
        const allMemoryHistory = [];
        const allGcHistory = [];
        const allTimestamps = [];
        const maxStoredPoints = 300;

        const cpuCanvas = document.getElementById('cpuChart');
        const memoryCanvas = document.getElementById('memoryChart');

        // Tab switching
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
            });
        });

        // Snapshot buttons
        document.getElementById('takeMemorySnapshot').addEventListener('click', () => {
            vscode.postMessage({ command: 'takeMemorySnapshot' });
        });

        document.getElementById('dumpMemoryToFile').addEventListener('click', () => {
            vscode.postMessage({ command: 'dumpMemoryToFile' });
        });

        document.getElementById('closeObjectsPanel').addEventListener('click', () => {
            document.getElementById('objectsPanel').style.display = 'none';
        });

        function showRootsForType(typeName) {
            vscode.postMessage({ command: 'getTypeRoots', typeName });
        }

        document.getElementById('takeCpuTrace').addEventListener('click', () => {
            const duration = parseInt(document.getElementById('traceDuration').value, 10);
            vscode.postMessage({ command: 'takeCpuTrace', duration });
        });

        document.getElementById('openSpeedscope').addEventListener('click', () => {
            vscode.postMessage({ command: 'openInSpeedscope' });
        });

        let currentSpeedscopeUrl = '';
        document.getElementById('copySpeedscopeUrl').addEventListener('click', () => {
            if (currentSpeedscopeUrl) {
                navigator.clipboard.writeText(currentSpeedscopeUrl).then(() => {
                    const btn = document.getElementById('copySpeedscopeUrl');
                    btn.textContent = '✓';
                    setTimeout(() => { btn.innerHTML = '&#128279;'; }, 1500);
                });
            }
        });

        // Zoom controls
        function updateZoomButtons() {
            document.getElementById('zoomIn').disabled = currentZoom === 0;
            document.getElementById('zoomOut').disabled = currentZoom === zoomLevels.length - 1;
            document.getElementById('zoomLabel').textContent = zoomLevels[currentZoom].label;
            maxPoints = zoomLevels[currentZoom].points;
        }

        document.getElementById('zoomIn').addEventListener('click', () => {
            if (currentZoom > 0) { currentZoom--; updateZoomButtons(); redrawCharts(); }
        });

        document.getElementById('zoomOut').addEventListener('click', () => {
            if (currentZoom < zoomLevels.length - 1) { currentZoom++; updateZoomButtons(); redrawCharts(); }
        });

        function formatTime(date) {
            return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }

        function formatBytes(bytes) {
            if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
            if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
            return bytes + ' B';
        }

        function getVisibleData() {
            const start = Math.max(0, allCpuHistory.length - maxPoints);
            return {
                cpu: allCpuHistory.slice(start),
                memory: allMemoryHistory.slice(start),
                gc: allGcHistory.slice(start),
                timestamps: allTimestamps.slice(start)
            };
        }

        function drawChart(canvas, datasets, yLabel, yMax, timestamps) {
            const ctx = canvas.getContext('2d');
            const rect = canvas.parentElement.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;

            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            canvas.style.width = rect.width + 'px';
            canvas.style.height = rect.height + 'px';
            ctx.scale(dpr, dpr);

            const width = rect.width;
            const height = rect.height;
            const padding = { top: 10, right: 15, bottom: 25, left: 45 };
            const chartW = width - padding.left - padding.right;
            const chartH = height - padding.top - padding.bottom;

            ctx.clearRect(0, 0, width, height);

            ctx.strokeStyle = '#3c3c3c';
            ctx.lineWidth = 1;
            ctx.fillStyle = '#888';
            ctx.font = '10px sans-serif';

            const ySteps = 4;
            for (let i = 0; i <= ySteps; i++) {
                const y = padding.top + (chartH / ySteps) * i;
                ctx.beginPath();
                ctx.moveTo(padding.left, y);
                ctx.lineTo(width - padding.right, y);
                ctx.stroke();

                const val = yMax - (yMax / ySteps) * i;
                ctx.textAlign = 'right';
                ctx.fillText(val.toFixed(0) + yLabel, padding.left - 5, y + 3);
            }

            if (timestamps.length > 0) {
                ctx.textAlign = 'center';
                const xStep = chartW / (maxPoints - 1);
                const numLabels = Math.min(5, timestamps.length);
                const showEvery = Math.max(1, Math.floor(timestamps.length / numLabels));

                for (let i = 0; i < timestamps.length; i += showEvery) {
                    const x = padding.left + i * xStep;
                    ctx.fillText(timestamps[i], x, height - 5);
                }
            }

            datasets.forEach(ds => {
                if (ds.data.length < 2) return;

                ctx.strokeStyle = ds.color;
                ctx.lineWidth = 2;
                ctx.beginPath();

                const xStep = chartW / (maxPoints - 1);
                ds.data.forEach((val, i) => {
                    const x = padding.left + i * xStep;
                    const y = padding.top + chartH - (val / yMax) * chartH;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                });
                ctx.stroke();
            });
        }

        function redrawCharts() {
            const visible = getVisibleData();
            if (visible.cpu.length === 0) return;

            const cpuMax = Math.max(10, Math.ceil(Math.max(...visible.cpu) * 1.2 / 10) * 10);
            const memMax = Math.max(100, Math.ceil(Math.max(...visible.memory, ...visible.gc) * 1.2 / 50) * 50);

            drawChart(cpuCanvas, [{ data: visible.cpu, color: '#4fc3f7' }], '%', cpuMax, visible.timestamps);
            drawChart(memoryCanvas, [
                { data: visible.memory, color: '#81c784' },
                { data: visible.gc, color: '#ffb74d' }
            ], '', memMax, visible.timestamps);
        }

        function update(data) {
            document.getElementById('cpuValue').textContent = data.cpu.toFixed(1) + '%';
            document.getElementById('memoryValue').textContent = data.memory.toFixed(1) + ' MB';
            document.getElementById('gcHeapValue').textContent = data.gcHeap.toFixed(1) + ' MB';

            allCpuHistory.push(data.cpu);
            allMemoryHistory.push(data.memory);
            allGcHistory.push(data.gcHeap);
            allTimestamps.push(formatTime(new Date(data.timestamp)));

            while (allCpuHistory.length > maxStoredPoints) {
                allCpuHistory.shift();
                allMemoryHistory.shift();
                allGcHistory.shift();
                allTimestamps.shift();
            }

            redrawCharts();
        }

        // Memory sort/filter state
        let memorySortCol = 'bytes';
        let memorySortAsc = false;
        let memoryDataRaw = [];
        let memoryDataPrev = null;
        let memoryFilter = '';

        document.getElementById('memoryFilter').addEventListener('input', (e) => {
            memoryFilter = e.target.value.toLowerCase();
            renderMemoryGrid();
        });

        function computeMemoryDeltas(current, previous) {
            if (!previous) return current;

            const prevMap = new Map();
            for (const row of previous) {
                prevMap.set(row.type, row);
            }

            return current.map(row => {
                const prev = prevMap.get(row.type);
                return {
                    ...row,
                    countDelta: prev ? row.count - prev.count : row.count,
                    bytesDelta: prev ? row.bytes - prev.bytes : row.bytes
                };
            });
        }

        function formatDelta(value, isBytes) {
            if (value === 0) return '<span style="color:#888">0</span>';
            const sign = value > 0 ? '+' : '';
            const color = value > 0 ? '#f44336' : '#4caf50';
            const formatted = isBytes ? formatBytes(Math.abs(value)) : Math.abs(value).toLocaleString();
            return '<span style="color:' + color + '">' + sign + (isBytes && value < 0 ? '-' : '') + (isBytes ? '' : value.toLocaleString()) + (isBytes ? (value > 0 ? '+' : '-') + formatted : '') + '</span>';
        }

        function formatDeltaNum(value) {
            if (value === 0) return '<span style="color:#888">0</span>';
            const sign = value > 0 ? '+' : '';
            const color = value > 0 ? '#f44336' : '#4caf50';
            return '<span style="color:' + color + '">' + sign + value.toLocaleString() + '</span>';
        }

        function formatDeltaBytes(value) {
            if (value === 0) return '<span style="color:#888">0</span>';
            const color = value > 0 ? '#f44336' : '#4caf50';
            const sign = value > 0 ? '+' : '-';
            return '<span style="color:' + color + '">' + sign + formatBytes(Math.abs(value)) + '</span>';
        }

        function renderMemoryGrid(data) {
            if (data !== undefined) {
                memoryDataPrev = memoryDataRaw.length > 0 ? memoryDataRaw : null;
                memoryDataRaw = data;
            }

            const withDeltas = computeMemoryDeltas(memoryDataRaw, memoryDataPrev);
            const filtered = withDeltas.filter(row =>
                row.type.toLowerCase().includes(memoryFilter)
            );
            sortMemoryData(filtered);

            const container = document.getElementById('memoryGridContainer');
            if (memoryDataRaw.length === 0) {
                container.innerHTML = '<div class="empty-state">No data available</div>';
                return;
            }
            if (filtered.length === 0) {
                container.innerHTML = '<div class="empty-state">No matching types</div>';
                return;
            }

            const hasDeltas = memoryDataPrev !== null;
            let html = '<div class="grid-container"><table class="data-grid"><thead><tr>';
            html += '<th data-col="type" class="type-col">Type (' + filtered.length + ')</th>';
            html += '<th data-col="count" class="num">Count</th>';
            if (hasDeltas) html += '<th data-col="countDelta" class="num">Count \u0394</th>';
            html += '<th data-col="bytes" class="num">Memory</th>';
            if (hasDeltas) html += '<th data-col="bytesDelta" class="num">Memory \u0394</th>';
            html += '</tr></thead><tbody>';

            for (const row of filtered) {
                html += '<tr>';
                html += '<td class="type-col clickable" data-type="' + escapeHtml(row.type) + '">' + escapeHtml(row.type) + '</td>';
                html += '<td class="num">' + row.count.toLocaleString() + '</td>';
                if (hasDeltas) html += '<td class="num">' + formatDeltaNum(row.countDelta) + '</td>';
                html += '<td class="num">' + formatBytes(row.bytes) + '</td>';
                if (hasDeltas) html += '<td class="num">' + formatDeltaBytes(row.bytesDelta) + '</td>';
                html += '</tr>';
            }

            html += '</tbody></table></div>';
            container.innerHTML = html;

            container.querySelectorAll('th').forEach(th => {
                th.addEventListener('click', () => {
                    const col = th.dataset.col;
                    if (memorySortCol === col) memorySortAsc = !memorySortAsc;
                    else { memorySortCol = col; memorySortAsc = col === 'type'; }
                    renderMemoryGrid();
                });
            });

            // Add click handlers for type cells to show GC roots
            container.querySelectorAll('.type-col.clickable').forEach(td => {
                td.addEventListener('click', () => {
                    const typeName = td.dataset.type;
                    if (typeName) {
                        showRootsForType(typeName);
                    }
                });
            });
        }

        function sortMemoryData(data) {
            data.sort((a, b) => {
                let cmp = 0;
                if (memorySortCol === 'type') cmp = a.type.localeCompare(b.type);
                else if (memorySortCol === 'count') cmp = a.count - b.count;
                else if (memorySortCol === 'countDelta') cmp = (a.countDelta || 0) - (b.countDelta || 0);
                else if (memorySortCol === 'bytesDelta') cmp = (a.bytesDelta || 0) - (b.bytesDelta || 0);
                else cmp = a.bytes - b.bytes;
                return memorySortAsc ? cmp : -cmp;
            });
        }

        // CPU sort/filter state
        let cpuSortCol = 'inclusivePercent';
        let cpuSortAsc = false;
        let cpuDataRaw = [];
        let cpuFilter = '';

        document.getElementById('cpuFilter').addEventListener('input', (e) => {
            cpuFilter = e.target.value.toLowerCase();
            renderCpuGrid();
        });

        function renderCpuGrid(data) {
            if (data !== undefined) cpuDataRaw = data;

            const filtered = cpuDataRaw.filter(row =>
                row.function.toLowerCase().includes(cpuFilter)
            );
            sortCpuData(filtered);

            const container = document.getElementById('cpuGridContainer');
            if (cpuDataRaw.length === 0) {
                container.innerHTML = '<div class="empty-state">No data available</div>';
                return;
            }
            if (filtered.length === 0) {
                container.innerHTML = '<div class="empty-state">No matching functions</div>';
                return;
            }

            let html = '<div class="grid-container"><table class="data-grid"><thead><tr>';
            html += '<th data-col="function" class="func-col">Function (' + filtered.length + ')</th>';
            html += '<th data-col="inclusivePercent" class="num">Inclusive %</th>';
            html += '<th data-col="exclusivePercent" class="num">Exclusive %</th>';
            html += '</tr></thead><tbody>';

            for (const row of filtered) {
                html += '<tr>';
                html += '<td class="func-col">' + escapeHtml(row.function) + '</td>';
                html += '<td class="num">' + row.inclusivePercent.toFixed(2) + '%</td>';
                html += '<td class="num">' + row.exclusivePercent.toFixed(2) + '%</td>';
                html += '</tr>';
            }

            html += '</tbody></table></div>';
            container.innerHTML = html;

            container.querySelectorAll('th').forEach(th => {
                th.addEventListener('click', () => {
                    const col = th.dataset.col;
                    if (cpuSortCol === col) cpuSortAsc = !cpuSortAsc;
                    else { cpuSortCol = col; cpuSortAsc = col === 'function'; }
                    renderCpuGrid();
                });
            });
        }

        function sortCpuData(data) {
            data.sort((a, b) => {
                let cmp = 0;
                if (cpuSortCol === 'function') cmp = a.function.localeCompare(b.function);
                else if (cpuSortCol === 'exclusivePercent') cmp = a.exclusivePercent - b.exclusivePercent;
                else cmp = a.inclusivePercent - b.inclusivePercent;
                return cpuSortAsc ? cmp : -cmp;
            });
        }

        function escapeHtml(str) {
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function truncate(str, len) {
            return str.length > len ? str.substring(0, len) + '...' : str;
        }

        window.addEventListener('message', e => {
            const msg = e.data;
            switch (msg.type) {
                case 'update':
                    update(msg.data);
                    break;
                case 'snapshotStarted':
                    const loadingHtml = '<div class="loading">Collecting data...</div>';
                    if (msg.tab === 'memory') {
                        document.getElementById('memoryGridContainer').innerHTML = loadingHtml;
                        document.getElementById('takeMemorySnapshot').disabled = true;
                    } else {
                        document.getElementById('cpuGridContainer').innerHTML = loadingHtml;
                        document.getElementById('takeCpuTrace').disabled = true;
                    }
                    break;
                case 'memorySnapshot':
                    document.getElementById('takeMemorySnapshot').disabled = false;
                    renderMemoryGrid(msg.data);
                    break;
                case 'cpuTrace':
                    document.getElementById('takeCpuTrace').disabled = false;
                    if (msg.hasTraceFile) {
                        document.getElementById('openSpeedscope').disabled = false;
                    }
                    renderCpuGrid(msg.data);
                    break;
                case 'snapshotError':
                    if (msg.tab === 'memory') {
                        document.getElementById('takeMemorySnapshot').disabled = false;
                        document.getElementById('memoryGridContainer').innerHTML = '<div class="empty-state">Error: ' + msg.error + '</div>';
                    } else {
                        document.getElementById('takeCpuTrace').disabled = false;
                        document.getElementById('cpuGridContainer').innerHTML = '<div class="empty-state">Error: ' + msg.error + '</div>';
                    }
                    break;
                case 'dumpStarted':
                    document.getElementById('dumpMemoryToFile').disabled = true;
                    document.getElementById('dumpMemoryToFile').textContent = 'Dumping...';
                    break;
                case 'dumpComplete':
                    document.getElementById('dumpMemoryToFile').disabled = false;
                    document.getElementById('dumpMemoryToFile').textContent = 'Dump Memory To File';
                    break;
                case 'dumpError':
                    document.getElementById('dumpMemoryToFile').disabled = false;
                    document.getElementById('dumpMemoryToFile').textContent = 'Dump Memory To File';
                    break;
                case 'rootsStarted':
                    showObjectsPanel(msg.typeName, '<div class="objects-loading">Loading objects for ' + escapeHtml(msg.typeName) + '...</div>');
                    break;
                case 'rootsResult':
                    renderObjectsResult(msg);
                    break;
                case 'rootsError':
                    showObjectsPanel('Error', '<div class="objects-empty">Error: ' + escapeHtml(msg.error) + '</div>');
                    break;
                case 'objectDetails':
                    updateObjectDetails(msg.address, msg.dumpObj, msg.gcRoot, msg.dumpPath);
                    // Also update any nested objects with this address
                    updateNestedObjectDetails(msg.address, msg.dumpObj, msg.gcRoot, msg.dumpPath);
                    break;
                case 'speedscopeUrl':
                    currentSpeedscopeUrl = msg.url;
                    document.getElementById('copySpeedscopeUrl').style.display = 'inline-block';
                    break;
            }
        });

        function showObjectsPanel(title, content) {
            const panel = document.getElementById('objectsPanel');
            document.getElementById('objectsPanelTitle').textContent = title;
            document.getElementById('objectsPanelContent').innerHTML = content;
            panel.style.display = 'flex';
        }

        let currentDumpPath = null;
        const objectDetailsCache = {};

        function renderObjectsResult(msg) {
            const { typeName, totalObjects, objects, dumpPath, message } = msg;

            currentDumpPath = dumpPath;

            if (message) {
                showObjectsPanel(typeName, '<div class="objects-empty">' + escapeHtml(message) + '</div>');
                return;
            }

            if (!objects || objects.length === 0) {
                showObjectsPanel(typeName, '<div class="objects-empty">No objects found</div>');
                return;
            }

            let html = '<div style="margin-bottom:8px;color:#888;">Showing ' + objects.length + ' of ' + totalObjects + ' objects (click to expand)</div>';

            for (let i = 0; i < objects.length; i++) {
                const obj = objects[i];
                html += '<div class="object-item" data-address="' + obj.address + '">';
                html += '<div class="object-header">';
                html += '<span class="object-toggle">&#9654;</span>';
                html += '<span class="object-address">0x' + obj.address + '</span>';
                html += '<span class="object-size">' + formatBytes(obj.size) + '</span>';
                html += '</div>';
                html += '<div class="object-details">';
                html += '<div class="object-tabs">';
                html += '<button class="object-tab active" data-tab="dumpobj">Object Dump</button>';
                html += '<button class="object-tab" data-tab="gcroot">GC Root</button>';
                html += '</div>';
                html += '<div class="object-tab-content active" data-tab="dumpobj"><div class="object-tab-loading">Loading...</div></div>';
                html += '<div class="object-tab-content" data-tab="gcroot"><div class="object-tab-loading">Loading...</div></div>';
                html += '</div>';
                html += '</div>';
            }

            showObjectsPanel(typeName, html);

            // Add click handlers for collapsible items
            document.querySelectorAll('.object-header').forEach(header => {
                header.addEventListener('click', () => {
                    const item = header.parentElement;
                    const wasExpanded = item.classList.contains('expanded');
                    item.classList.toggle('expanded');

                    // Lazy load details when first expanded
                    if (!wasExpanded) {
                        const address = item.dataset.address;
                        if (!objectDetailsCache[address] && currentDumpPath) {
                            vscode.postMessage({ command: 'getObjectDetails', dumpPath: currentDumpPath, address });
                        }
                    }
                });
            });

            // Add click handlers for tabs within each object
            document.querySelectorAll('.object-tabs').forEach(tabsContainer => {
                tabsContainer.querySelectorAll('.object-tab').forEach(tab => {
                    tab.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const tabName = tab.dataset.tab;
                        const details = tabsContainer.parentElement;

                        // Update active tab
                        tabsContainer.querySelectorAll('.object-tab').forEach(t => t.classList.remove('active'));
                        tab.classList.add('active');

                        // Update active content
                        details.querySelectorAll('.object-tab-content').forEach(c => c.classList.remove('active'));
                        details.querySelector('.object-tab-content[data-tab="' + tabName + '"]').classList.add('active');
                    });
                });
            });
        }

        function updateObjectDetails(address, dumpObj, gcRoot, dumpPath) {
            objectDetailsCache[address] = { dumpObj, gcRoot, dumpPath };

            const item = document.querySelector('.object-item[data-address="' + address + '"]');
            if (!item) return;

            const dumpObjContent = item.querySelector('.object-tab-content[data-tab="dumpobj"]');
            const gcRootContent = item.querySelector('.object-tab-content[data-tab="gcroot"]');

            if (dumpObjContent) {
                dumpObjContent.innerHTML = renderDumpObjContent(dumpObj, dumpPath);
                // Add click handlers for reference fields
                dumpObjContent.querySelectorAll('.field-ref').forEach(el => {
                    el.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const fieldAddress = el.dataset.address;
                        const fieldDumpPath = el.dataset.dumppath;
                        if (fieldAddress && fieldDumpPath) {
                            // Request details for this nested object
                            vscode.postMessage({ command: 'getObjectDetails', dumpPath: fieldDumpPath, address: fieldAddress });
                            // Create a new expandable item for this object
                            addNestedObjectItem(el, fieldAddress, fieldDumpPath);
                        }
                    });
                });
            }
            if (gcRootContent) {
                gcRootContent.innerHTML = '<pre style="margin:0;">' + escapeHtml(gcRoot) + '</pre>';
            }
        }

        function renderDumpObjContent(dumpObj, dumpPath) {
            let html = '';

            // Render header info
            if (dumpObj.header && dumpObj.header.length > 0) {
                html += '<pre style="margin:0 0 12px 0;color:#888;">' + escapeHtml(dumpObj.header.join('\\n')) + '</pre>';
            }

            // Render fields in class-definition style
            if (dumpObj.fields && dumpObj.fields.length > 0) {
                html += '<div class="fields-list">';
                for (const field of dumpObj.fields) {
                    const staticPrefix = field.isStatic ? 'static ' : '';
                    const offsetInfo = '(offset 0x' + field.offset + ')';

                    if (field.isReference) {
                        // Clickable reference type
                        html += '<div class="field-line">';
                        html += '<span class="field-static">' + staticPrefix + '</span>';
                        html += '<span class="field-type">' + escapeHtml(field.type) + '</span> ';
                        html += '<span class="field-name">' + escapeHtml(field.name) + '</span>; ';
                        html += '<span class="field-ref" data-address="' + field.value + '" data-dumppath="' + escapeHtml(dumpPath) + '">';
                        html += '(0x' + field.value + ')';
                        html += '</span> ';
                        html += '<span class="field-offset">' + offsetInfo + '</span>';
                        html += '</div>';
                    } else {
                        // Value type or null
                        html += '<div class="field-line">';
                        html += '<span class="field-static">' + staticPrefix + '</span>';
                        html += '<span class="field-type">' + escapeHtml(field.type) + '</span> ';
                        html += '<span class="field-name">' + escapeHtml(field.name) + '</span>; ';
                        html += '<span class="field-value">(0x' + field.value + ')</span> ';
                        html += '<span class="field-offset">' + offsetInfo + '</span>';
                        html += '</div>';
                    }
                }
                html += '</div>';
            } else {
                html += '<div style="color:#888;font-style:italic;">No fields</div>';
            }

            return html;
        }

        function addNestedObjectItem(clickedEl, address, dumpPath) {
            // Check if we already have this nested object expanded
            const existingNested = clickedEl.parentElement.querySelector('.nested-object[data-address="' + address + '"]');
            if (existingNested) {
                existingNested.classList.toggle('expanded');
                return;
            }

            // Create nested object container
            const nestedDiv = document.createElement('div');
            nestedDiv.className = 'nested-object expanded';
            nestedDiv.dataset.address = address;
            nestedDiv.innerHTML = '<div class="nested-object-header">' +
                '<span class="object-toggle">&#9654;</span>' +
                '<span class="object-address">0x' + address + '</span>' +
                '</div>' +
                '<div class="nested-object-details">' +
                '<div class="object-tabs">' +
                '<button class="object-tab active" data-tab="dumpobj">Object Dump</button>' +
                '<button class="object-tab" data-tab="gcroot">GC Root</button>' +
                '</div>' +
                '<div class="object-tab-content active" data-tab="dumpobj"><div class="object-tab-loading">Loading...</div></div>' +
                '<div class="object-tab-content" data-tab="gcroot"><div class="object-tab-loading">Loading...</div></div>' +
                '</div>';

            // Insert after the clicked field line
            clickedEl.parentElement.insertAdjacentElement('afterend', nestedDiv);

            // Add collapse/expand handler
            nestedDiv.querySelector('.nested-object-header').addEventListener('click', (e) => {
                e.stopPropagation();
                nestedDiv.classList.toggle('expanded');
            });

            // Add tab handlers
            nestedDiv.querySelectorAll('.object-tab').forEach(tab => {
                tab.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const tabName = tab.dataset.tab;
                    nestedDiv.querySelectorAll('.object-tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    nestedDiv.querySelectorAll('.object-tab-content').forEach(c => c.classList.remove('active'));
                    nestedDiv.querySelector('.object-tab-content[data-tab="' + tabName + '"]').classList.add('active');
                });
            });

            // Check cache or request data
            if (objectDetailsCache[address]) {
                const cached = objectDetailsCache[address];
                updateNestedObjectDetails(address, cached.dumpObj, cached.gcRoot, cached.dumpPath);
            }
        }

        function updateNestedObjectDetails(address, dumpObj, gcRoot, dumpPath) {
            const nestedDiv = document.querySelector('.nested-object[data-address="' + address + '"]');
            if (!nestedDiv) return;

            const dumpObjContent = nestedDiv.querySelector('.object-tab-content[data-tab="dumpobj"]');
            const gcRootContent = nestedDiv.querySelector('.object-tab-content[data-tab="gcroot"]');

            if (dumpObjContent) {
                dumpObjContent.innerHTML = renderDumpObjContent(dumpObj, dumpPath);
                // Add click handlers for nested reference fields
                dumpObjContent.querySelectorAll('.field-ref').forEach(el => {
                    el.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const fieldAddress = el.dataset.address;
                        const fieldDumpPath = el.dataset.dumppath;
                        if (fieldAddress && fieldDumpPath) {
                            vscode.postMessage({ command: 'getObjectDetails', dumpPath: fieldDumpPath, address: fieldAddress });
                            addNestedObjectItem(el, fieldAddress, fieldDumpPath);
                        }
                    });
                });
            }
            if (gcRootContent) {
                gcRootContent.innerHTML = '<pre style="margin:0;">' + escapeHtml(gcRoot) + '</pre>';
            }
        }

        window.addEventListener('resize', redrawCharts);
        updateZoomButtons();
    </script>
</body>
</html>`;
}

async function startMonitoring(): Promise<void> {
    if (monitoringProcess) {
        vscode.window.showWarningMessage('Monitoring is already running. Stop it first before starting a new session.');
        return;
    }

    if (!await ensureTool('dotnet-counters')) {
        return;
    }

    const processId = await getDebuggedProcessId();
    if (!processId) {
        return;
    }

    currentProcessId = processId;

    if (panel) {
        panel.reveal(vscode.ViewColumn.Beside);
    } else {
        panel = createWebviewPanel(processId);
    }

    outputFile = path.join(os.tmpdir(), `dotnet-counters-${processId}-${Date.now()}.json`);
    lastFileSize = 0;
    lastEventCount = 0;

    monitoringProcess = spawn('dotnet-counters', [
        'collect',
        '--process-id', processId.toString(),
        '--refresh-interval', '1',
        '--format', 'json',
        '--output', outputFile
    ], { shell: true });

    monitoringProcess.on('error', (error) => {
        vscode.window.showErrorMessage(`Failed to start dotnet-counters: ${error.message}`);
        cleanup();
    });

    monitoringProcess.on('close', (code) => {
        if (code !== 0 && code !== null) {
            vscode.window.showWarningMessage(`dotnet-counters exited with code ${code}`);
        }
        cleanup();
    });

    startFilePolling();
    vscode.window.showInformationMessage(`Monitoring .NET process ${processId}`);
}

function startFilePolling(): void {
    readInterval = setInterval(() => {
        if (!outputFile || !fs.existsSync(outputFile)) {
            return;
        }

        try {
            const content = fs.readFileSync(outputFile, 'utf8');
            if (content.length > lastFileSize) {
                lastFileSize = content.length;
                parseAndUpdateChart(content);
            }
        } catch {
            // File might be locked
        }
    }, 1000);
}

function parseAndUpdateChart(content: string): void {
    try {
        let json = content;
        if (!json.trim().endsWith(']}')) {
            json = json.replace(/,\s*$/, '') + ']}';
        }

        const data = JSON.parse(json) as CounterData;

        if (data.Events && data.Events.length > lastEventCount) {
            const newEvents = data.Events.slice(lastEventCount);
            lastEventCount = data.Events.length;

            const grouped = new Map<string, CounterEvent[]>();
            for (const event of newEvents) {
                const timestamp = event.timestamp ? event.timestamp.substring(0, 19) : 'unknown';
                if (!grouped.has(timestamp)) {
                    grouped.set(timestamp, []);
                }
                grouped.get(timestamp)!.push(event);
            }

            for (const [timestamp, events] of grouped) {
                const metrics = extractMetrics(events, timestamp);
                if (metrics.cpu > 0 || metrics.memory > 0 || metrics.gcHeap > 0) {
                    if (panel) {
                        panel.webview.postMessage({
                            type: 'update',
                            data: metrics
                        });
                    }
                }
            }
        }
    } catch {
        // JSON parsing failed
    }
}

function extractMetrics(events: CounterEvent[], timestamp: string): { cpu: number; memory: number; gcHeap: number; timestamp: string } {
    let cpu = 0;
    let memory = 0;
    let gcHeap = 0;

    for (const event of events) {
        const name = event.name;

        if (name === 'CPU Usage (%)') {
            cpu = event.value;
        } else if (name === 'Working Set (MB)') {
            memory = event.value;
        } else if (name === 'GC Heap Size (MB)') {
            gcHeap = event.value;
        }
    }

    return { cpu, memory, gcHeap, timestamp };
}

interface CounterEvent {
    timestamp: string;
    provider: string;
    name: string;
    tags: string;
    counterType: string;
    value: number;
}

interface CounterData {
    TargetProcess: string;
    StartTime: string;
    Events: CounterEvent[];
}

function cleanup(): void {
    if (readInterval) {
        clearInterval(readInterval);
        readInterval = null;
    }
    if (outputFile && fs.existsSync(outputFile)) {
        try {
            fs.unlinkSync(outputFile);
        } catch {
            // Ignore
        }
        outputFile = null;
    }
    monitoringProcess = null;
    lastFileSize = 0;
    lastEventCount = 0;
}

function stopMonitoring(): void {
    if (monitoringProcess) {
        const pid = monitoringProcess.pid;
        if (pid) {
            try {
                process.kill(-pid, 'SIGTERM');
            } catch {
                monitoringProcess.kill('SIGTERM');
            }
        }

        setTimeout(() => {
            if (monitoringProcess) {
                try {
                    monitoringProcess.kill('SIGKILL');
                } catch {
                    // Already dead
                }
            }
            cleanup();
        }, 500);

        vscode.window.showInformationMessage('DotNet Profiler monitoring stopped.');
    } else {
        vscode.window.showInformationMessage('No monitoring session is active.');
    }
}

export function deactivate() {
    stopMonitoring();
    if (panel) {
        panel.dispose();
    }
}
