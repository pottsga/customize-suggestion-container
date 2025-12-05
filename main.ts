import { App, Plugin, PluginSettingTab, Setting, TFile, parseYaml } from 'obsidian';
import { DateTime } from 'luxon';

interface PropertiesInSuggestionSettings {
	properties: string;    // CSV of properties to display
	dateFormat: string;    // Luxon date format
	ignoreFolders: string; // CSV of folder paths to ignore
}

const DEFAULT_SETTINGS: PropertiesInSuggestionSettings = {
	properties: 'Categories',
	dateFormat: 'yyyy-MM-dd hhmmA',
	ignoreFolders: ''
};

export default class PropertiesInSuggestionPlugin extends Plugin {
	settings: PropertiesInSuggestionSettings;
	private observer: MutationObserver | null = null;
	private suggestionContentToModify = '.suggestion-content:not(.modal-container .suggestion-content)';
	private fileMap: Record<string, string> = {}; // alias or GUID → real path

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new PropertiesInSuggestionSettingTab(this.app, this));

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

	private isFileIgnored(filePath: string) {
		const ignoreFolders = this.settings.ignoreFolders
			.split(',')
			.map(f => f.trim())
			.filter(f => f.length > 0);
		return ignoreFolders.some(folder => filePath.startsWith(folder + '/'));
	}

	private async processSuggestionContent(el: HTMLElement) {
		const allowedProps = this.settings.properties
			.split(',')
			.map(p => p.trim())
			.filter(p => p.length > 0);

		const titleEl = el.querySelector('.suggestion-title');
		const noteEl = el.querySelector('.suggestion-note');
		if (!titleEl || !noteEl) return;

		const title = titleEl.textContent?.trim() ?? '';
		const note = noteEl.textContent?.trim() ?? '';

		let filename = '';
		if (note === '') {
			filename = `${title}.md`;
		} else if (note.endsWith('/')) {
			filename = `${note}${title}.md`;
		} else {
			filename = `${note}.md`;
		}

		const fileProperties = await this.getMetadataPropertiesFromFile(this.settings.properties, filename);

		// Clear old properties to avoid duplication
		el.querySelectorAll('.suggestion-property').forEach(node => node.remove());

		// Render properties
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

	private async getMetadataPropertiesFromFile(properties: string, filename: string) {
		const requested = properties
			.split(',')
			.map(p => p.trim())
			.filter(p => p.length > 0);

		const file = this.app.vault.getAbstractFileByPath(filename);
		if (!file || !(file instanceof TFile)) return {};
		if (this.isFileIgnored(file.path)) return {};

		const content = await this.app.vault.read(file);

		// Extract YAML frontmatter
		const match = /^---\s*([\s\S]*?)\s*---/m.exec(content);
		if (!match) return {};

		const yamlBlock = match[1];

		// Parse YAML via Obsidian API
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

class PropertiesInSuggestionSettingTab extends PluginSettingTab {
	plugin: PropertiesInSuggestionPlugin;

	constructor(app: App, plugin: PropertiesInSuggestionPlugin) {
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
			.setName('Folders to ignore')
			.setDesc('CSV list of folder paths to skip when looking for properties')
			.addText(text => text
				.setPlaceholder('Templates, Archive')
				.setValue(this.plugin.settings.ignoreFolders)
				.onChange(async (value) => {
					this.plugin.settings.ignoreFolders = value;
					await this.plugin.saveSettings();
				}));
	}
}
