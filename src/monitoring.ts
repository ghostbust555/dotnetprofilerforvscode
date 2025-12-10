import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ensureTool } from './tools';
import { getDebuggedProcessId } from './processes';
import { CounterData, CounterEvent } from './types';

let monitoringProcess: ChildProcess | null = null;
let readInterval: ReturnType<typeof setInterval> | null = null;
let outputFile: string | null = null;
let lastFileSize = 0;
let lastEventCount = 0;

export function isMonitoring(): boolean {
    return monitoringProcess !== null;
}

export async function startMonitoring(
    panel: vscode.WebviewPanel | null,
    createPanel: (processId: number) => vscode.WebviewPanel,
    setPanel: (p: vscode.WebviewPanel) => void,
    setCurrentProcessId: (pid: number) => void
): Promise<void> {
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

    setCurrentProcessId(processId);

    if (panel) {
        panel.reveal(vscode.ViewColumn.Beside);
    } else {
        const newPanel = createPanel(processId);
        setPanel(newPanel);
        panel = newPanel;
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

    startFilePolling(panel);
    vscode.window.showInformationMessage(`Monitoring .NET process ${processId}`);
}

function startFilePolling(panel: vscode.WebviewPanel | null): void {
    readInterval = setInterval(() => {
        if (!outputFile || !fs.existsSync(outputFile)) {
            return;
        }

        try {
            const content = fs.readFileSync(outputFile, 'utf8');
            if (content.length > lastFileSize) {
                lastFileSize = content.length;
                parseAndUpdateChart(content, panel);
            }
        } catch {
            // File might be locked
        }
    }, 1000);
}

function parseAndUpdateChart(content: string, panel: vscode.WebviewPanel | null): void {
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

export function stopMonitoring(): void {
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
