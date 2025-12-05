import { App, Plugin, PluginSettingTab, Setting, TFile, parseYaml } from 'obsidian';
import { DateTime } from 'luxon';

interface CustomizeSuggestionContainerSettings {
	properties: string;    // CSV of properties to display
	dateFormat: string;    // Luxon date format
	hideFolders: string;   // CSV of folder paths to hide
	showCreatedDate: boolean;
	showModifiedDate: boolean;
	hideNonexistentFiles: boolean;
}

const DEFAULT_SETTINGS: CustomizeSuggestionContainerSettings = {
	properties: 'Categories',
	dateFormat: 'yyyy-MM-dd hhmma',
	hideFolders: 'Templates, Archive',
	showCreatedDate: false,
	showModifiedDate: false,
	hideNonexistentFiles: true,
};

export default class CustomizeSuggestionContainerPlugin extends Plugin {
	settings: CustomizeSuggestionContainerSettings;
	private observer: MutationObserver | null = null;
	// private suggestionContentToModify = '.suggestion-content:not(.modal-container .suggestion-content), .prompt-results .suggestion-content';
	private suggestionContentToModify = '.suggestion-content';

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new CustomizeSuggestionContainerSettingTab(this.app, this));

		this.observer = new MutationObserver(async (mutations) => {
			for (const m of mutations) {
				for (const n of Array.from(m.addedNodes)) {
					if (!(n instanceof HTMLElement)) continue;

					if (n.matches(this.suggestionContentToModify)) {
						await this.processSuggestionContent(n);
					} else {
						const nestedAll = n.querySelectorAll(this.suggestionContentToModify);
						for (const el of Array.from(nestedAll)) {
							if (el instanceof HTMLElement) {
								await this.processSuggestionContent(el);
							}
						}
					}
				}
			}
		});

		this.observer.observe(document.body, {
			childList: true,
			subtree: true
		});
	}

	onunload() {
		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private isFileHidden(filePath: string) {
		const hideFolders = this.settings.hideFolders
			.split(',')
			.map(f => f.trim())
			.filter(f => f.length > 0);

		return hideFolders.some(folder => filePath.startsWith(folder + '/'));
	}

	private hasCommandInputAncestor(el: HTMLElement): boolean {
		let parent = el.parentElement;
		while (parent) {
			if (
				parent.querySelector(
					'.prompt-input-container input[placeholder="Select a command..."]'
				)
			) {
				return true;
			}
			parent = parent.parentElement;
		}
		return false;
	}


	private async processSuggestionContent(el: HTMLElement) {

		// Do not hide or modify anything if this suggestion is in the command-palette UI
		if (this.hasCommandInputAncestor(el)) {
			return;
		}
		console.log(el.outerHTML)
		const titleEl = el.querySelector('.suggestion-title');
		const noteEl = el.querySelector('.suggestion-note');
		if (!titleEl) return;

		const title = titleEl.textContent?.trim() ?? '';
		const note = noteEl?.textContent?.trim() ?? '';

		// check to see if the element contains any parent with a child of .prompt-input-container that contains an input with a placeholder of "Select a command..." if it does, then DON'T hide it.

		// If both title and note are empty, hide the suggestion
		if (title === '' && note === '') {
			el.style.display = 'none';
			return;
		}

		console.log(`note: ${note}`)

		let filename = '';
		if (note === '') {
			filename = `${title}.md`;
		} else if (note.endsWith('/')) {
			filename = `${note}${title}.md`;
		} else {
			filename = `${note}.md`;
		}

		// Try to find the actual file in the vault
		let file = this.app.vault.getAbstractFileByPath(filename) as TFile | null;
		if (!file) {
			const allFiles = this.app.vault.getMarkdownFiles();
			const matching = allFiles.find(f => f.name === `${title}.md`);
			if (matching) file = matching;
		}

		if (!file) {
			// Remove the nonexistent file if the setting is set to true.
			if (this.settings.hideNonexistentFiles) {
				const parentItem = el.closest('.suggestion-item');
				if (parentItem) parentItem.remove();
			}
			return;
		}

		// Skip hidden folders by removing the top-level suggestion-item
		if (this.isFileHidden(file.path)) {
			const parentItem = el.closest('.suggestion-item');
			if (parentItem) parentItem.remove();
			return;
		}

		const fileProperties = await this.getMetadataPropertiesFromFile(this.settings.properties, file);

		// Clear old properties to avoid duplication
		el.querySelectorAll('.suggestion-property').forEach(node => node.remove());

		// Add created / modified dates if enabled
		if (this.settings.showCreatedDate) {
			const createdEl = document.createElement('div');
			createdEl.className = 'suggestion-property';
			createdEl.textContent = 'Created: ' + DateTime.fromMillis(file.stat.ctime).toFormat(this.settings.dateFormat);
			el.appendChild(createdEl);
		}

		if (this.settings.showModifiedDate) {
			const modifiedEl = document.createElement('div');
			modifiedEl.className = 'suggestion-property';
			modifiedEl.textContent = 'Modified: ' + DateTime.fromMillis(file.stat.mtime).toFormat(this.settings.dateFormat);
			el.appendChild(modifiedEl);
		}

		// Render YAML properties
		for (const [key, value] of Object.entries(fileProperties)) {
			const propEl = document.createElement('div');
			propEl.className = 'suggestion-property';

			const values = Array.isArray(value) ? value : [value];
			values.forEach(val => {
				let node: Node;

				const linkMatch = val.match(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/);
				if (linkMatch) {
					const cleaned = val.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, '$3$1');
					const span = document.createElement('span');
					span.style.color = 'var(--link-color)';
					span.style.textDecoration = 'underline';
					span.textContent = cleaned;
					node = span;
				} else if (this.settings.dateFormat) {
					const dt = DateTime.fromISO(val);
					node = dt.isValid ? document.createTextNode(dt.toFormat(this.settings.dateFormat)) : document.createTextNode(val);
				} else {
					node = document.createTextNode(val);
				}

				propEl.appendChild(node);
				propEl.appendChild(document.createTextNode(' '));
			});

			el.appendChild(propEl);
		}
	}

	private async getMetadataPropertiesFromFile(properties: string, file: TFile) {
		const requested = properties
			.split(',')
			.map(p => p.trim())
			.filter(p => p.length > 0);

		const content = await this.app.vault.read(file);

		// Extract YAML frontmatter
		const match = /^---\s*([\s\S]*?)\s*---/m.exec(content);
		if (!match) return {};

		const yamlBlock = match[1];

		let parsed: any = {};
		try {
			parsed = parseYaml(yamlBlock) ?? {};
		} catch {
			return {};
		}

		// Pick requested properties
		const result: Record<string, any> = {};
		for (const prop of requested) {
			if (prop in parsed) {
				result[prop] = parsed[prop];
			}
		}

		return result;
	}
}

class CustomizeSuggestionContainerSettingTab extends PluginSettingTab {
	plugin: CustomizeSuggestionContainerPlugin;

	constructor(app: App, plugin: CustomizeSuggestionContainerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Properties')
			.setDesc('CSV list of properties to show in the suggestion container.')
			.addText(text => text
				.setPlaceholder('Categories, Date')
				.setValue(this.plugin.settings.properties)
				.onChange(async (value) => {
					this.plugin.settings.properties = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Date format for properties')
			.setDesc('Format for date properties (Luxon tokens, e.g., yyyy-MM-dd)')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.dateFormat)
				.onChange(async (value) => {
					this.plugin.settings.dateFormat = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Folders to hide in suggestion container')
			.setDesc('CSV list of folder paths to hide from the suggestion container')
			.addText(text => text
				.setPlaceholder('Templates, Archive')
				.setValue(this.plugin.settings.hideFolders)
				.onChange(async (value) => {
					this.plugin.settings.hideFolders = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show created date?')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.showCreatedDate)
					.onChange(async (value) => {
						this.plugin.settings.showCreatedDate = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Show created date?')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.showModifiedDate)
					.onChange(async (value) => {
						this.plugin.settings.showModifiedDate = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Hide files that do not exist?')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.hideNonexistentFiles)
					.onChange(async (value) => {
						this.plugin.settings.hideNonexistentFiles = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
