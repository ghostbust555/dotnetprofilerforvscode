import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { DotNetProcess } from './types';

export async function listDotNetProcesses(): Promise<DotNetProcess[]> {
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

export async function findProcessByWorkspacePath(): Promise<number | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return null;
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;
    const processes = await listDotNetProcesses();

    const userProcesses = filterUserProcesses(processes);

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

export function filterUserProcesses(processes: DotNetProcess[]): DotNetProcess[] {
    return processes.filter(p =>
        !p.commandLine.includes('.vscode/extensions') &&
        !p.commandLine.includes('.vscode\\extensions') &&
        !p.commandLine.includes('MSBuild.dll') &&
        !p.commandLine.includes('vstest.console.dll') &&
        !p.name.includes('dotnet-counters') &&
        !p.name.includes('dotnet-trace') &&
        !p.name.includes('dotnet-gcdump')
    );
}

export async function selectFromProcessList(processes: DotNetProcess[]): Promise<number | null> {
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

export function isDotNetSession(session: vscode.DebugSession): boolean {
    return session.type === 'coreclr' || session.type === 'clr' || session.type === 'dotnet';
}

export async function getDebuggedProcessId(): Promise<number | null> {
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
    const userProcesses = filterUserProcesses(allProcesses);

    if (userProcesses.length === 0) {
        vscode.window.showErrorMessage('No .NET processes found. Make sure your application is running.');
        return null;
    }

    return selectFromProcessList(userProcesses);
}
