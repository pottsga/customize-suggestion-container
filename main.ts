import { App, Plugin, PluginSettingTab, Setting, TFile, parseYaml } from 'obsidian';
import { DateTime } from 'luxon';

interface CustomizeSuggestionContainerSettings {
	properties: string;    // CSV of properties to display
	dateFormat: string;    // Luxon date format
	hideFolders: string;   // CSV of folder paths to hide
	showCreatedDate: boolean;
	showModifiedDate: boolean;
	hideNonexistentFiles: boolean;
	commandsToHide: string;
}

const DEFAULT_SETTINGS: CustomizeSuggestionContainerSettings = {
	properties: 'Categories',
	dateFormat: 'yyyy-MM-dd hhmma',
	hideFolders: 'Templates, Archive',
	showCreatedDate: false,
	showModifiedDate: false,
	hideNonexistentFiles: true,
	commandsToHide: '',
};

export default class CustomizeSuggestionContainerPlugin extends Plugin {
	settings: CustomizeSuggestionContainerSettings;
	private observer: MutationObserver | null = null;
	private suggestionContentToModify = '.suggestion-content';

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new CustomizeSuggestionContainerSettingTab(this.app, this));
		console.debug('[customize-suggestion] loaded settings:', this.settings);

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
		console.debug('[customize-suggestion] mutation observer started.');
	}

	onunload() {
		console.debug('[customize-suggestion] unloading...');
		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}
		console.debug('[customize-suggestion] unloaded.');
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

	private getCommandHideRegexes(): RegExp[] {
		const raw = this.settings.commandsToHide ?? '';
		const parts = raw
			.split(',')
			.map(s => s.trim())
			.filter(s => s.length > 0);

		console.debug('[customize-suggestion] parsing commandsToHide parts:', parts);

		const regexes: RegExp[] = [];
		for (const p of parts) {
			try {
				let r: RegExp | null = null;
				if (p.startsWith('/') && p.lastIndexOf('/') > 0) {
					const lastSlash = p.lastIndexOf('/');
					const pattern = p.slice(1, lastSlash);
					const flags = p.slice(lastSlash + 1);
					r = new RegExp(pattern, flags);
				} else {
					r = new RegExp(p, 'i'); // default case-insensitive
				}
				regexes.push(r);
			} catch (e) {
				console.warn('[customize-suggestion] invalid regex in commandsToHide, skipping:', p, e);
			}
		}

		console.debug('[customize-suggestion] compiled regexes count:', regexes.length);
		return regexes;
	}

	private async processSuggestionContent(el: HTMLElement) {
		console.debug('[customize-suggestion] processSuggestionContent start', {
			tag: el.tagName,
			classes: el.className,
			snippet: el.textContent?.slice(0, 200)
		});

		const isCommandPalette = this.hasCommandInputAncestor(el);
		console.debug('[customize-suggestion] isCommandPalette:', isCommandPalette);

		const hideRegexes = this.getCommandHideRegexes();

		const titleEl = el.querySelector('.suggestion-title');
		if (!titleEl) return;

		// Get prefix text
		const prefixEl = titleEl.querySelector('.suggestion-prefix');
		const prefixText = prefixEl?.textContent?.trim() ?? '';

		// Get all other text nodes inside titleEl, excluding the prefix
		const restText = Array.from(titleEl.childNodes)
			.filter(node => node !== prefixEl)
			.map(node => node.textContent?.trim() ?? '')
			.filter(t => t.length > 0)
			.join(' ');

		// Combine prefix and rest
		const fullCommandLabel = prefixText ? `${prefixText}: ${restText}` : restText;

		console.debug('[customize-suggestion] fullCommandLabel:', fullCommandLabel);

		// Remove suggestion if it matches any hide regex
		if (isCommandPalette && hideRegexes.length > 0) {
			for (const re of hideRegexes) {
				const matched = re.test(fullCommandLabel);
				console.debug('[customize-suggestion] testing regex:', re, '->', matched);
				if (matched) {
					const parentItem = el.closest('.suggestion-item');
					if (parentItem) parentItem.remove();
					console.debug('[customize-suggestion] removed suggestion-item matching commandsToHide');
					return;
				}
			}
		}

		// Skip command palette suggestions if no match
		if (isCommandPalette) {
			console.debug('[customize-suggestion] inside command palette and no hide match -> skipping file processing.');
			return;
		}

		// Normal suggestion file processing
		const noteEl = el.querySelector('.suggestion-note');
		const note = noteEl?.textContent?.trim() ?? '';
		const title = fullCommandLabel;

		if (title === '' && note === '') {
			el.style.display = 'none';
			return;
		}

		let filename = '';
		if (note === '') {
			filename = `${title}.md`;
		} else if (note.endsWith('/')) {
			filename = `${note}${title}.md`;
		} else {
			filename = `${note}.md`;
		}

		let file = this.app.vault.getAbstractFileByPath(filename) as TFile | null;
		if (!file) {
			const allFiles = this.app.vault.getMarkdownFiles();
			const matching = allFiles.find(f => f.name === `${title}.md`);
			if (matching) file = matching;
		}

		if (!file) {
			if (this.settings.hideNonexistentFiles) {
				const parentItem = el.closest('.suggestion-item');
				if (parentItem) parentItem.remove();
			}
			return;
		}

		if (this.isFileHidden(file.path)) {
			const parentItem = el.closest('.suggestion-item');
			if (parentItem) parentItem.remove();
			return;
		}

		const fileProperties = await this.getMetadataPropertiesFromFile(this.settings.properties, file);

		// Clear old properties
		el.querySelectorAll('.suggestion-property').forEach(node => node.remove());

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

		for (const [key, value] of Object.entries(fileProperties)) {
			const propEl = document.createElement('div');
			propEl.className = 'suggestion-property';
			const values = Array.isArray(value) ? value : [value];
			values.forEach(val => {
				let node: Node;
				const linkMatch = typeof val === 'string' ? val.match(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/) : null;
				if (linkMatch) {
					const cleaned = (val as string).replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, '$3$1');
					const span = document.createElement('span');
					span.style.color = 'var(--link-color)';
					span.style.textDecoration = 'underline';
					span.textContent = cleaned;
					node = span;
				} else if (this.settings.dateFormat && typeof val === 'string') {
					const dt = DateTime.fromISO(val);
					node = dt.isValid ? document.createTextNode(dt.toFormat(this.settings.dateFormat)) : document.createTextNode(String(val));
				} else {
					node = document.createTextNode(String(val));
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

		let content: string;
		try {
			content = await this.app.vault.read(file);
		} catch {
			return {};
		}

		const match = /^---\s*([\s\S]*?)\s*---/m.exec(content);
		if (!match) return {};

		let parsed: any = {};
		try {
			parsed = parseYaml(match[1]) ?? {};
		} catch {
			return {};
		}

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
				.setValue(this.plugin.settings.dateFormat)
				.onChange(async (value) => {
					this.plugin.settings.dateFormat = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Folders to hide in suggestion container')
			.setDesc('CSV list of folder paths to hide')
			.addText(text => text
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
			.setName('Show modified date?')
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

		new Setting(containerEl)
			.setName('Commands to Hide')
			.setDesc('CSV list of regex patterns matching full command labels to hide. Example: QuickAdd:')
			.addText(text => text
				.setValue(this.plugin.settings.commandsToHide)
				.onChange(async (value) => {
					this.plugin.settings.commandsToHide = value;
					await this.plugin.saveSettings();
					console.debug('[customize-suggestion] commandsToHide updated:', value);
				}));
	}
}
