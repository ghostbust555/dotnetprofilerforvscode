import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ensureTool } from './tools';
import { CpuTraceEntry } from './types';
import { setCpuContext } from './ai';

let currentTraceFile: string | null = null;

export function getCurrentTraceFile(): string | null {
    return currentTraceFile;
}

export function setCurrentTraceFile(traceFile: string | null): void {
    currentTraceFile = traceFile;
}

export async function takeCpuTrace(
    durationSeconds: number,
    currentProcessId: number | null,
    panel: vscode.WebviewPanel | null
): Promise<void> {
    if (!currentProcessId) {
        vscode.window.showErrorMessage('No process being monitored');
        return;
    }

    if (!await ensureTool('dotnet-trace')) {
        return;
    }

    panel?.webview.postMessage({ type: 'snapshotStarted', tab: 'cpu' });

    if (currentTraceFile && fs.existsSync(currentTraceFile)) {
        try { fs.unlinkSync(currentTraceFile); } catch { /* ignore */ }
    }

    const traceFile = path.join(os.tmpdir(), `dotnet-trace-${currentProcessId}-${Date.now()}.nettrace`);

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

            const reportProc = spawn('dotnet-trace', ['report', traceFile, 'topN', '-n', '50', '--inclusive'], { shell: true });
            let reportOutput = '';

            reportProc.stdout.on('data', (data) => {
                reportOutput += data.toString();
            });

            reportProc.on('close', (reportCode) => {
                if (reportCode === 0) {
                    const results = parseCpuTraceOutput(reportOutput);
                    setCpuContext(results);
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

export async function openInSpeedscope(panel: vscode.WebviewPanel | null): Promise<void> {
    if (!currentTraceFile || !fs.existsSync(currentTraceFile)) {
        vscode.window.showErrorMessage('No trace file available. Take a CPU trace first.');
        return;
    }

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
                    launchSpeedscope(speedscopeFile, panel);
                } else {
                    const altFile = currentTraceFile!.replace('.nettrace', '.speedscope.json');
                    if (fs.existsSync(altFile)) {
                        launchSpeedscope(altFile, panel);
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

function launchSpeedscope(filePath: string, panel: vscode.WebviewPanel | null): void {
    const openProc = spawn('speedscope', [filePath], {
        shell: true,
        detached: true
    });

    let speedscopeOutput = '';

    openProc.stdout?.on('data', (data) => {
        speedscopeOutput += data.toString();
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

export function parseCpuTraceOutput(output: string): CpuTraceEntry[] {
    const results: CpuTraceEntry[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
        const match = line.match(/^\d+\.\s+(.+?)\s{2,}([\d.]+)%\s+([\d.]+)%/);
        if (match) {
            const funcName = match[1].trim();
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
