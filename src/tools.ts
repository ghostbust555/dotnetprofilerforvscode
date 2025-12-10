import * as vscode from 'vscode';
import { spawn } from 'child_process';

export async function isToolInstalled(toolName: string): Promise<boolean> {
    return new Promise((resolve) => {
        const proc = spawn(toolName, ['--version'], { shell: true });
        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
    });
}

export async function installTool(toolName: string): Promise<boolean> {
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

export async function ensureTool(toolName: string): Promise<boolean> {
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
