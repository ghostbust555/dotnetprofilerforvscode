import * as vscode from 'vscode';
import { isDotNetSession } from './processes';
import { takeMemorySnapshot, dumpMemoryToFile, getTypeRoots, getObjectDetails, openDumpInTerminal } from './memory';
import { takeCpuTrace, openInSpeedscope } from './cpu';
import { startMonitoring, stopMonitoring } from './monitoring';
import { getWebviewContent } from './webview';
import { analyzeWithAI } from './ai';

let panel: vscode.WebviewPanel | null = null;
let extensionContext: vscode.ExtensionContext;
let currentProcessId: number | null = null;

export function activate(context: vscode.ExtensionContext) {
    console.log('DotNet Profiler extension is now active');
    extensionContext = context;

    const startCommand = vscode.commands.registerCommand('dotnet-profiler.startMonitoring', async () => {
        await startMonitoring(
            panel,
            createWebviewPanel,
            (p) => { panel = p; },
            (pid) => { currentProcessId = pid; }
        );
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
                        startMonitoring(
                            panel,
                            createWebviewPanel,
                            (p) => { panel = p; },
                            (pid) => { currentProcessId = pid; }
                        );
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
                    await takeMemorySnapshot(currentProcessId, panel);
                    break;
                case 'takeCpuTrace':
                    await takeCpuTrace(message.duration || 5, currentProcessId, panel);
                    break;
                case 'dumpMemoryToFile':
                    await dumpMemoryToFile(currentProcessId, panel);
                    break;
                case 'getTypeRoots':
                    await getTypeRoots(message.typeName, currentProcessId, panel);
                    break;
                case 'getObjectDetails':
                    await getObjectDetails(message.dumpPath, message.address, panel);
                    break;
                case 'openInSpeedscope':
                    await openInSpeedscope(panel);
                    break;
                case 'askAI':
                    await analyzeWithAI(message.question, panel);
                    break;
                case 'openDumpTerminal':
                    openDumpInTerminal();
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

export function deactivate() {
    stopMonitoring();
    if (panel) {
        panel.dispose();
    }
}
