import * as vscode from 'vscode';
import * as path from 'path';

let lastMemoryData: string | null = null;
let lastCpuData: string | null = null;

export function setMemoryContext(data: Array<{ type: string; count: number; bytes: number }>): void {
    if (data && data.length > 0) {
        // Store top 100 types by bytes for context
        const sorted = [...data].sort((a, b) => b.bytes - a.bytes).slice(0, 100);
        lastMemoryData = sorted.map(d => `${d.type}: ${d.count} objects, ${formatBytes(d.bytes)}`).join('\n');
    }
}

export function setCpuContext(data: Array<{ function: string; inclusivePercent: number; exclusivePercent: number }>): void {
    if (data && data.length > 0) {
        lastCpuData = data.map(d => `${d.function}: ${d.inclusivePercent.toFixed(2)}% inclusive, ${d.exclusivePercent.toFixed(2)}% exclusive`).join('\n');
    }
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return bytes + ' B';
}

async function getWorkspaceContext(): Promise<string> {
    let context = '';

    // Get workspace folder info
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const rootPath = workspaceFolders[0].uri.fsPath;
        context += `## Workspace: ${path.basename(rootPath)}\n\n`;

        // Get project files (.csproj, .sln)
        const projectFiles = await vscode.workspace.findFiles('**/*.{csproj,sln,fsproj}', '**/node_modules/**', 10);
        if (projectFiles.length > 0) {
            context += '### Project Files:\n';
            for (const file of projectFiles) {
                const relativePath = path.relative(rootPath, file.fsPath);
                context += `- ${relativePath}\n`;
            }
            context += '\n';
        }

        // Get C# source files structure (just paths, not contents)
        const sourceFiles = await vscode.workspace.findFiles('**/*.cs', '**/obj/**', 50);
        if (sourceFiles.length > 0) {
            context += '### Source Files:\n';
            for (const file of sourceFiles) {
                const relativePath = path.relative(rootPath, file.fsPath);
                context += `- ${relativePath}\n`;
            }
            context += '\n';
        }
    }

    // Get currently open/active editor content
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.languageId === 'csharp') {
        const doc = activeEditor.document;
        const fileName = path.basename(doc.fileName);
        const content = doc.getText();

        // Limit content size to avoid token limits
        const maxChars = 8000;
        const truncatedContent = content.length > maxChars
            ? content.substring(0, maxChars) + '\n... (truncated)'
            : content;

        context += `### Currently Open File (${fileName}):\n\`\`\`csharp\n${truncatedContent}\n\`\`\`\n\n`;
    }

    // Get visible editors (other open tabs)
    const visibleEditors = vscode.window.visibleTextEditors.filter(
        e => e !== activeEditor && e.document.languageId === 'csharp'
    );

    for (const editor of visibleEditors.slice(0, 2)) { // Limit to 2 additional files
        const doc = editor.document;
        const fileName = path.basename(doc.fileName);
        const content = doc.getText();

        const maxChars = 4000;
        const truncatedContent = content.length > maxChars
            ? content.substring(0, maxChars) + '\n... (truncated)'
            : content;

        context += `### Open File (${fileName}):\n\`\`\`csharp\n${truncatedContent}\n\`\`\`\n\n`;
    }

    return context;
}

export async function analyzeWithAI(
    userQuestion: string,
    panel: vscode.WebviewPanel | null
): Promise<void> {
    // Select a Copilot model
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });

    if (models.length === 0) {
        panel?.webview.postMessage({
            type: 'aiResponse',
            error: 'No language model available. Please ensure GitHub Copilot is installed and signed in.'
        });
        return;
    }

    const model = models[0];

    // Build context from available data
    let context = 'You are a .NET performance analysis expert. ';
    context += 'Help analyze the following profiling data and answer the user\'s question.\n';
    context += 'You have access to the workspace structure and open files to help correlate profiling data with code.\n\n';

    // Add workspace context (file structure and open files)
    const workspaceContext = await getWorkspaceContext();
    if (workspaceContext) {
        context += workspaceContext;
    }

    if (lastMemoryData) {
        context += '## Memory Snapshot (Top types by size):\n```\n' + lastMemoryData + '\n```\n\n';
    }

    if (lastCpuData) {
        context += '## CPU Trace (Hot functions):\n```\n' + lastCpuData + '\n```\n\n';
    }

    if (!lastMemoryData && !lastCpuData) {
        context += 'No profiling data has been captured yet. Please take a memory snapshot or CPU trace first.\n\n';
    }

    context += 'User question: ' + userQuestion;

    const messages = [
        vscode.LanguageModelChatMessage.User(context)
    ];

    try {
        panel?.webview.postMessage({ type: 'aiResponseStart' });

        const chatResponse = await model.sendRequest(
            messages,
            {},
            new vscode.CancellationTokenSource().token
        );

        let fullResponse = '';
        for await (const fragment of chatResponse.text) {
            fullResponse += fragment;
            panel?.webview.postMessage({
                type: 'aiResponseChunk',
                chunk: fragment
            });
        }

        panel?.webview.postMessage({
            type: 'aiResponseEnd',
            response: fullResponse
        });

    } catch (err) {
        let errorMessage = 'Failed to get AI response';
        if (err instanceof vscode.LanguageModelError) {
            if (err.code === 'NoPermissions') {
                errorMessage = 'Please allow access to GitHub Copilot for this extension.';
            } else if (err.code === 'Blocked') {
                errorMessage = 'Request was blocked. Please try rephrasing your question.';
            } else if (err.code === 'NotFound') {
                errorMessage = 'Language model not found. Please ensure GitHub Copilot is installed.';
            } else {
                errorMessage = err.message;
            }
        } else if (err instanceof Error) {
            errorMessage = err.message;
        }

        panel?.webview.postMessage({
            type: 'aiResponse',
            error: errorMessage
        });
    }
}
