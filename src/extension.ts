import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Better Prompts');
    outputChannel.appendLine('Extension activated.');

    // Execute git ls-files for instant native search respecting all .gitignores
    async function getWorkspaceFiles(workspaceRoot: string): Promise<string[]> {
        try {
            const { stdout } = await execAsync('git ls-files --cached --others --exclude-standard', { 
                cwd: workspaceRoot, 
                maxBuffer: 1024 * 1024 * 10 
            });
            return stdout.split('\n').filter(p => p.length > 0);
        } catch (e) {
            outputChannel.appendLine('git ls-files failed, falling back to findFiles: ' + e);
            return await getFilesFallback(workspaceRoot);
        }
    }

    async function getFilesFallback(workspaceRoot: string): Promise<string[]> {
        const filesExclude = vscode.workspace.getConfiguration('files', vscode.Uri.file(workspaceRoot)).get<Record<string, boolean>>('exclude') || {};
        const searchExclude = vscode.workspace.getConfiguration('search', vscode.Uri.file(workspaceRoot)).get<Record<string, boolean>>('exclude') || {};
    
        const excludePatterns = [
            ...Object.keys(filesExclude).filter(k => filesExclude[k]),
            ...Object.keys(searchExclude).filter(k => searchExclude[k]),
            '**/.git/**'
        ];
        
        const excludeGlob = `{${excludePatterns.join(',')}}`;
        const uris = await vscode.workspace.findFiles('**/*', excludeGlob);
        return uris.map(uri => vscode.workspace.asRelativePath(uri, false));
    }

    // Autocomplete Provider
    const provider = vscode.languages.registerCompletionItemProvider(
        { pattern: '**/*.prompt.md' }, 
        {
            async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
                const startTime = Date.now();
                
                const wordRange = document.getWordRangeAtPosition(position, /@[^\s]*/);
                if (!wordRange) {
                    return undefined;
                }
                const word = document.getText(wordRange);

                if (!word.startsWith('@')) {
                    return undefined;
                }

                const homeDir = os.homedir();
                const completionItems: vscode.CompletionItem[] = [];

                const folders = vscode.workspace.workspaceFolders || [];
                for (const folder of folders) {
                    const rootPath = folder.uri.fsPath;
                    const relativePaths = await getWorkspaceFiles(rootPath);
                    
                    const uniqueDirs = new Set<string>();

                    for (const relPath of relativePaths) {
                        const absolutePath = path.join(rootPath, relPath);
                        
                        let displayPath = absolutePath;
                        if (displayPath.startsWith(homeDir)) {
                            displayPath = displayPath.replace(homeDir, '');
                        }
                        
                        const label = relPath;
                        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.File);
                        
                        item.range = wordRange;
                        item.filterText = `@${label}`;
                        item.insertText = `@/~${displayPath}`;
                        item.detail = `~${displayPath}`;
                        
                        completionItems.push(item);

                        // Extract directories recursively
                        let dir = path.dirname(relPath);
                        while (dir !== '.' && dir !== '' && dir !== '/') {
                            uniqueDirs.add(dir);
                            dir = path.dirname(dir);
                        }
                    }

                    // Add unique folders to the autocomplete
                    for (const dirRelPath of uniqueDirs) {
                        const absolutePath = path.join(rootPath, dirRelPath);
                        let displayPath = absolutePath;
                        if (displayPath.startsWith(homeDir)) {
                            displayPath = displayPath.replace(homeDir, '');
                        }
                        
                        const label = dirRelPath;
                        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Folder);
                        
                        item.range = wordRange;
                        item.filterText = `@${label}`;
                        item.insertText = `@/~${displayPath}`;
                        item.detail = `~${displayPath}`;
                        
                        completionItems.push(item);
                    }
                }

                outputChannel.appendLine(`Returned ${completionItems.length} completion items in ${Date.now() - startTime}ms`);
                return completionItems;
            }
        },
        '@' 
    );
    context.subscriptions.push(provider);

    // New File Command
    const newFileCmd = vscode.commands.registerCommand('better-prompts.newPromptFile', async () => {
        const fileName = await vscode.window.showInputBox({
            prompt: 'Enter the name for the new prompt file',
            placeHolder: 'untitled'
        });

        if (fileName === undefined) {
            return; // User cancelled
        }

        const baseName = fileName.trim() || 'untitled';
        
        const config = vscode.workspace.getConfiguration('better-prompts');
        let targetDirRaw = config.get<string>('promptLocation') || '~/Library/prompts';
        
        if (targetDirRaw.startsWith('~')) {
            targetDirRaw = targetDirRaw.replace('~', os.homedir());
        }
        const targetDir = path.resolve(targetDirRaw);
        
        // Ensure the directory exists
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        // Handle naming collisions
        let finalName = `${baseName}.prompt.md`;
        let counter = 1;
        while (fs.existsSync(path.join(targetDir, finalName))) {
            finalName = `${baseName}${counter}.prompt.md`;
            counter++;
        }

        const newFilePath = path.join(targetDir, finalName);
        fs.writeFileSync(newFilePath, ''); 
        
        // Open the newly created file smoothly
        const doc = await vscode.workspace.openTextDocument(newFilePath);
        await vscode.window.showTextDocument(doc);
        
        // Pin the editor automatically
        await vscode.commands.executeCommand('workbench.action.pinEditor');
    });
    context.subscriptions.push(newFileCmd);

    // Change Prompt Location Command
    const changeLocationCmd = vscode.commands.registerCommand('better-prompts.changePromptLocation', async () => {
        const config = vscode.workspace.getConfiguration('better-prompts');
        const currentValue = config.get<string>('promptLocation') || '~/Library/prompts';
        
        const newLocation = await vscode.window.showInputBox({
            prompt: 'Enter the new directory path for prompt files',
            value: currentValue
        });

        if (newLocation !== undefined && newLocation.trim() !== '') {
            await config.update('promptLocation', newLocation.trim(), vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Prompt location updated to: ${newLocation.trim()}`);
        }
    });
    context.subscriptions.push(changeLocationCmd);
}

export function deactivate() {}
