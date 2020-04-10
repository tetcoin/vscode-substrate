import * as vscode from 'vscode';

import { Category } from './types';
import { getManifestPath } from './getManifestPath';
import { substrateDepsInstalled } from './substrateDeps';
import { TreeDataProvider, TreePallet } from './TreeDataProvider';
import fetchCategories from './fetchCategories';
import Runtimes from './runtimes/Runtimes';
import CurrentRuntime from './runtimes/CurrentRuntime';

export function activate(context: vscode.ExtensionContext) {
	init(context);
}

export function deactivate() { }

function init(context: vscode.ExtensionContext) {
	fetchCategories().then((categories: Category[]) => {
		// TODO make this a class. Makes it easier to have common access to common
		// dependencies (runtimes; currentRuntime), and automatically breaks down
		// the code into functions.

		// Set up tree view
		const runtimes = new Runtimes();
		const currentRuntime = new CurrentRuntime(runtimes);
		const treeView = vscode.window.createTreeView('substrateMarketplace', {treeDataProvider: new TreeDataProvider(categories, currentRuntime)});
		currentRuntime.changes$.subscribe((change) => {
			if (change && runtimes.runtimes$.getValue().length > 1)
				treeView.message = `Current runtime: ${change.shortname}`;
			else
				treeView.message = ``;
		});

		// Set up commands: documentation, github, homepage
		([
			{ command: 'substrateMarketplace.palletDocumentation', name: 'Documentation', property: 'documentation'},
			{ command: 'substrateMarketplace.palletGithub', name: 'GitHub page', property: 'github'},
			{ command: 'substrateMarketplace.palletHomepage', name: 'Homepage', property: 'homepage'}
		] as const).forEach(({command, name, property}) => {
			vscode.commands.registerCommand(command, (item: TreePallet) => {
				if (!item[property].startsWith('http')) { // Also acts as a safeguard
					vscode.window.showErrorMessage(`${name} is unavailable for this pallet.`);
					return;
				}
				vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(item[property]));
			});
		});

		// Set up command: install
		vscode.commands.registerCommand("substrateMarketplace.installPallet", async (item: vscode.TreeItem) => {
			// Install substrate-deps if needed
			if (!await substrateDepsInstalled()) {
				return;
			}

			// Verify pallet name to prevent shell injection & derive alias
			const palletName = item.label as string;
			if (!/^[a-z-]+$/.test(palletName)) {
				vscode.window.showErrorMessage('Pallet name is invalid.');
				return;
			}
			const alias = (alias => alias === palletName ? null : alias)(palletName.replace(/^pallet-/, ''));

			// Ask for user confirmation
			// TODO Indicate current runtime in the message in case we have more than
			// one runtime in the workspace.
			const clicked = await vscode.window.showInformationMessage(`Install the pallet ${palletName}?`, { modal: true }, 'Yes');
			if (clicked !== 'Yes') {
				return;
			}

			// Get manifest path
			let manifestPath: string;
			try {
				let currentRuntimeChanges = currentRuntime.changes$.getValue();
				manifestPath = await getManifestPath(currentRuntimeChanges?.runtimePath || null, runtimes);
			} catch (e) {
				return;
			}

			// Prepare command
			const termCommand = [
				'substrate-deps',
				`add ${palletName}`,
				...alias ? [`--alias ${alias}`] : [],
				`--manifest-path '${manifestPath.replace(/'/, `'\\''`)}'`, // Allow spaces in path, prevent command injection (TODO Windows?)
				'&& exit'
			].join(' ');

			// Create terminal and run command
			const term = vscode.window.createTerminal({ name: `Installing ${palletName}` });
			term.sendText(termCommand);

			// Manage outcome

			// We currently assume that if the command takes more than a certain time
			// to complete, it probably failed. We then show the hidden terminal to
			// the user. We should find a better way to check if the command error'ed.
			// (IPC?) TODO
			const revealTerminalTimeout = setTimeout(() => {
				vscode.window.showErrorMessage(`An error might have occurred when installing ${palletName} using project runtime manifest ${manifestPath}. Please check the terminal for more information.`);
				term.show();
				disp.dispose();
			}, 5000);

			// TODO Reuse resolveWhenTerminalClosed
			// TODO In case of multiple runtimes, indicate the runtime it was installed on.
			const disp = vscode.window.onDidCloseTerminal(t => {
				if (t === term) {
					disp.dispose();
					if (t?.exitStatus?.code === 0) {
						vscode.window.showInformationMessage(`${palletName} was successfully added to the project${alias ? ` as '${alias}'` : ''}.`);
						clearTimeout(revealTerminalTimeout);
					}
				}
			});

		});
	}, (async r => { // Offer to retry in case fetching the categories failed
			const clicked = await vscode.window.showErrorMessage(`An error occured when fetching the list of pallets from the Substrate Marketplace: ${r}`, 'Try again');
			if (clicked === 'Try again') {
				return init(context);
			}
	}));
}