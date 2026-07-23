import { Plugin, Setting, PluginSettingTab, Notice, App, Modal, ButtonComponent } from 'obsidian';
import { DailyNoteManager, SyncMode } from './src/services/dailyNoteManager';
import { MemosProfile, MemosSettings } from './src/types';
import { SyncStateManager } from './src/utils/syncStateManager'; // 引入新的状态管理器
import { t } from './src/i18n/translationManager';

interface LegacySettings {
    apiUrl?: unknown;
    apiToken?: unknown;
    apiVersion?: unknown;
    dailyMemoHeader?: unknown;
    syncDaysLimit?: unknown;
    profiles?: unknown;
    lastSyncByProfile?: unknown; // 旧版字段，用于迁移判断
    lastSyncDate?: unknown;
}

// [修改说明]：假设已在 src/types.ts 中为 MemosSettings 添加了以下字段：
// excludeTags: string[];       // 排除的标签列表
// syncStateFilePath: string;   // 状态文件存储路径
// debugMode: boolean;          // 调试模式开关
// 如果尚未添加，请先添加，或在此处扩展接口定义。
const DEFAULT_SETTINGS: MemosSettings = {
    profiles: [],
    attachmentFolderPath: 'assets',
    createMissingDailyNotes: true,
    useCalloutFormat: false,
    useListCalloutFormat: false,
    skipImages: false,
    enableAutoSyncOnStartup: false,
    startupSyncDelay: 5,
    skipIfSyncedToday: true,
    periodicSyncInterval: 0,
    enableMirrorDelete: false, 
    showEmoji: false,
    tagMode: 'smart',
    customTag: '#Memos',
    // --- [新增] 默认值设置 ---
    excludeTags: [], // 默认不排除任何标签
    syncStateFilePath: '.memos_sync/sync-state.json', // 默认状态文件路径
    debugMode: false, // 默认关闭调试模式
};

function generateProfileId(): string {
    return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultProfile(): MemosProfile {
    return {
        id: generateProfileId(),
        name: 'Default',
        apiUrl: '',
        apiToken: '',
        dailyMemoHeader: '## 📓 Memos',
        syncDaysLimit: 30,
        enabled: true,
    };
}

/**
 * Migrate flat v1.5.x settings (apiUrl/apiToken/...) into the new profiles[] shape.
 */
function migrateSettings(raw: unknown): MemosSettings {
    const legacy = (raw && typeof raw === 'object' ? raw : {}) as LegacySettings;
    const merged: MemosSettings = {
        ...DEFAULT_SETTINGS,
        ...(legacy as object)
    };

    // 迁移旧的平铺配置到 profiles
    if (!Array.isArray(merged.profiles) || merged.profiles.length === 0) {
        const legacyApiUrl = typeof legacy.apiUrl === 'string' ? legacy.apiUrl : '';
        const legacyApiToken = typeof legacy.apiToken === 'string' ? legacy.apiToken : '';
        const legacyHeader = typeof legacy.dailyMemoHeader === 'string' ? legacy.dailyMemoHeader : '## 📓 Memos';
        const legacyDays = typeof legacy.syncDaysLimit === 'number' ? legacy.syncDaysLimit : 30;

        if (legacyApiUrl || legacyApiToken) {
            merged.profiles = [{
                id: generateProfileId(),
                name: 'Default',
                apiUrl: legacyApiUrl,
                apiToken: legacyApiToken,
                dailyMemoHeader: legacyHeader,
                syncDaysLimit: legacyDays,
                enabled: !!(legacyApiUrl && legacyApiToken),
            }];
        } else {
            merged.profiles = [];
        }
    }

    // Strip legacy top-level fields so they don't get re-saved.
    const cleaned = merged as MemosSettings & LegacySettings;
    delete cleaned.apiUrl;
    delete cleaned.apiToken;
    delete cleaned.apiVersion;
    delete cleaned.dailyMemoHeader;
    delete cleaned.syncDaysLimit;
    // 清理旧的状态字段，这些现在由文件管理
    delete cleaned.lastSyncByProfile;
    delete cleaned.memoStatesByProfile;
    delete cleaned.lastSyncDate;
    return merged;
}

class ConfirmModal extends Modal {
    constructor(app: App, private message: string, private onConfirm: () => void) {
        super(app);
    }
    onOpen(): void {
        this.contentEl.createEl('p', { text: this.message });
        const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
        new ButtonComponent(buttons)
            .setButtonText(t.t('CONFIRM_CANCEL'))
            .onClick(() => this.close());
        new ButtonComponent(buttons)
            .setButtonText(t.t('CONFIRM_OK'))
            .setWarning()
            .onClick(() => {
                this.close();
                this.onConfirm();
            });
    }
    onClose(): void {
        this.contentEl.empty();
    }
}

export default class YetAnotherMemosSyncPlugin extends Plugin {
    settings: MemosSettings;
    private dailyNoteManager: DailyNoteManager;
    public syncStateManager: SyncStateManager; // 新增：状态管理器实例
    private periodicSyncIntervalId: number | null = null;

    async onload(): Promise<void> {
        await this.loadSettings();

        // --- [新增] 初始化状态管理器，传入自定义路径 ---
        // 注意：如果路径为空，则使用默认路径
        const stateFilePath = this.settings.syncStateFilePath || DEFAULT_SETTINGS.syncStateFilePath;
        this.syncStateManager = new SyncStateManager(this.app, stateFilePath);
        await this.syncStateManager.load();

        // 将状态管理器注入到 DailyNoteManager，同时传入 settings 以便使用最新配置
        this.dailyNoteManager = new DailyNoteManager(this.app, this.settings, this.syncStateManager);

        this.addRibbonIcon('sync', t.t('SYNC_MEMOS'), () => {
            void this.runSync('smart');
        });

        this.addCommand({
            id: 'sync-memos',
            name: t.t('SYNC_MEMOS'),
            callback: () => {
                void this.runSync('smart');
            },
        });

        this.addCommand({
            id: 'incremental-sync-memos',
            name: t.t('INCREMENTAL_SYNC_MEMOS'),
            callback: () => {
                void this.runSync('incremental');
            },
        });

        this.addCommand({
            id: 'force-sync-memos',
            name: t.t('FORCE_SYNC_MEMOS'),
            callback: () => {
                void this.runSync('force');
            },
        });

        this.addSettingTab(new YetAnotherMemosSyncSettingTab(this.app, this));

        if (this.settings.enableAutoSyncOnStartup) {
            this.scheduleStartupSync();
        }
        this.schedulePeriodicSync();
    }

    async loadSettings(): Promise<void> {
        const raw: unknown = await this.loadData();
        this.settings = migrateSettings(raw);
        // Persist migration result so legacy fields don't linger
        await this.saveData(this.settings);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        this.dailyNoteManager.updateSettings(this.settings);
        this.schedulePeriodicSync();
    }

    private async runSync(mode: SyncMode): Promise<void> {
        try {
            new Notice(mode === 'force' ? t.t('FORCE_SYNC_STARTING') : t.t('SYNC_STARTING'));
            await this.dailyNoteManager.syncAll(mode);
            new Notice(mode === 'force' ? t.t('FORCE_SYNC_SUCCESS') : t.t('SYNC_SUCCESS'));
        } catch (error) {
            console.error(`Sync (${mode}) failed:`, error);
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`${mode === 'force' ? t.t('FORCE_SYNC_FAILED') : t.t('SYNC_FAILED')}: ${message}`);
        }
    }

    private scheduleStartupSync(): void {
        // --- 修改：使用 syncStateManager 判断是否同步过 ---
        if (this.settings.skipIfSyncedToday && this.syncStateManager.hasSyncedToday()) {
            return;
        }
        const handle = window.setTimeout(() => {
            void this.runSync('smart');
        }, this.settings.startupSyncDelay * 1000);
        this.register(() => window.clearTimeout(handle));
    }

    private schedulePeriodicSync(): void {
        if (this.periodicSyncIntervalId !== null) {
            window.clearInterval(this.periodicSyncIntervalId);
            this.periodicSyncIntervalId = null;
        }
        if (this.settings.periodicSyncInterval > 0) {
            const id = window.setInterval(
                () => {
                    void this.runSync('smart');
                },
                this.settings.periodicSyncInterval * 60 * 1000,
            );
            this.periodicSyncIntervalId = id;
            this.registerInterval(id);
        }
    }

    addProfile(): MemosProfile {
        const profile = defaultProfile();
        profile.name = `Account ${this.settings.profiles.length + 1}`;
        this.settings.profiles.push(profile);
        return profile;
    }

    removeProfile(profileId: string): void {
        this.settings.profiles = this.settings.profiles.filter(p => p.id !== profileId);
        // 注意：这里不需要手动清理 lastSyncByProfile 了，SyncStateManager 会处理，
        // 而且 gcMemoStates 会自动清理过期的状态。
        // 如果需要立即清空该 profile 的所有状态，可以添加相关方法，但通常不需要。
    }
}

class YetAnotherMemosSyncSettingTab extends PluginSettingTab {
    plugin: YetAnotherMemosSyncPlugin;

    constructor(app: App, plugin: YetAnotherMemosSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl).setName(t.t('SETTINGS_TITLE')).setHeading();
        this.renderProfilesSection(containerEl);
        this.renderSyncFormatSection(containerEl);
        this.renderAutoSyncSection(containerEl);
        // --- [新增] 渲染高级设置区域 ---
        this.renderAdvancedSection(containerEl);
    }

    private renderProfilesSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName(t.t('PROFILES_TITLE'))
            .setDesc(t.t('PROFILES_DESC'))
            .setHeading();

        const profiles = this.plugin.settings.profiles;
        if (profiles.length === 0) {
            containerEl.createEl('p', { text: t.t('NO_PROFILES_HINT'), cls: 'setting-item-description' });
        }
        for (const profile of profiles) {
            this.renderProfile(containerEl, profile);
        }

        new Setting(containerEl).addButton(btn => btn
            .setButtonText(t.t('ADD_PROFILE'))
            .setCta()
            .onClick(async () => {
                this.plugin.addProfile();
                await this.plugin.saveSettings();
                this.display();
            }));
    }

    private renderProfile(containerEl: HTMLElement, profile: MemosProfile): void {
        const card = containerEl.createDiv({ cls: 'yams-profile-card' });
        new Setting(card).setName(profile.name || 'Unnamed').setHeading();

        new Setting(card)
            .setName(t.t('PROFILE_NAME_LABEL'))
            .setDesc(t.t('PROFILE_NAME_DESC'))
            .addText(text => text
                .setValue(profile.name)
                .onChange(async (value) => {
                    profile.name = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(card)
            .setName(t.t('PROFILE_ENABLED_LABEL'))
            .addToggle(toggle => toggle
                .setValue(profile.enabled)
                .onChange(async (value) => {
                    profile.enabled = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(card)
            .setName(t.t('API_URL_NAME'))
            .setDesc(t.t('API_URL_DESC'))
            .addText(text => text
                .setPlaceholder('https://memos.example.com')
                .setValue(profile.apiUrl)
                .onChange(async (value) => {
                    profile.apiUrl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(card)
            .setName(t.t('API_TOKEN_NAME'))
            .setDesc(t.t('API_TOKEN_DESC'))
            .addText(text => text
                .setPlaceholder('Enter your API token')
                .setValue(profile.apiToken)
                .onChange(async (value) => {
                    profile.apiToken = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(card)
            .setName(t.t('DAILY_HEADER_NAME'))
            .setDesc(t.t('DAILY_HEADER_DESC'))
            .addText(text => text
                .setPlaceholder('## 📓 Memos')
                .setValue(profile.dailyMemoHeader)
                .onChange(async (value) => {
                    profile.dailyMemoHeader = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(card)
            .setName(t.t('SYNC_DAYS_LIMIT_NAME'))
            .setDesc(t.t('SYNC_DAYS_LIMIT_DESC'))
            .addText(text => text
                .setPlaceholder('30')
                .setValue(String(profile.syncDaysLimit))
                .onChange(async (value) => {
                    profile.syncDaysLimit = Number(value) || 0;
                    await this.plugin.saveSettings();
                }));

        new Setting(card).addButton(btn => btn
            .setButtonText(t.t('REMOVE_PROFILE'))
            .setWarning()
            .onClick(() => {
                new ConfirmModal(this.app, t.t('REMOVE_PROFILE_CONFIRM'), () => {
                    this.plugin.removeProfile(profile.id);
                    void this.plugin.saveSettings().then(() => this.display());
                }).open();
            }));
    }

    private renderSyncFormatSection(containerEl: HTMLElement): void {
        new Setting(containerEl).setName(t.t('SYNC_CONFIG_TITLE')).setHeading();

        new Setting(containerEl)
            .setName('开启镜像删除 (双向同步删除)')
            .setDesc('开启后，删除 Obsidian 本地日记将同步删除 Memos 服务端数据，反之亦然。关闭则只同步新增和修改，防止误删数据。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableMirrorDelete)
                .onChange(async (value) => {
                    this.plugin.settings.enableMirrorDelete = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t.t('ATTACHMENT_FOLDER_NAME'))
            .setDesc(t.t('ATTACHMENT_FOLDER_DESC'))
            .addText(text => text
                .setPlaceholder('Attachments')
                .setValue(this.plugin.settings.attachmentFolderPath)
                .onChange(async (value) => {
                    this.plugin.settings.attachmentFolderPath = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t.t('CREATE_MISSING_NOTES_NAME'))
            .setDesc(t.t('CREATE_MISSING_NOTES_DESC'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.createMissingDailyNotes)
                .onChange(async (value) => {
                    this.plugin.settings.createMissingDailyNotes = value;
                    await this.plugin.saveSettings();
                }));

        // --- 新增设置：显示 Emoji ---
        new Setting(containerEl)
            .setName('显示 Emoji')
            .setDesc('在时间前显示表情符号')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showEmoji)
                .onChange(async (value) => {
                    this.plugin.settings.showEmoji = value;
                    await this.plugin.saveSettings();
                }));

        // --- 新增设置：标签模式 ---
        new Setting(containerEl)
            .setName('标签模式')
            .setDesc('如何处理标签')
            .addDropdown(dropdown => dropdown
                .addOption('none', '不添加标签')
                .addOption('smart', '智能添加 (无标签时添加)')
                .addOption('always', '始终添加')
                .setValue(this.plugin.settings.tagMode)
                .onChange(async (value: string) => {
                    (this.plugin.settings.tagMode as any) = value;
                    await this.plugin.saveSettings();
                }));

        // --- 新增设置：自定义标签 ---
        new Setting(containerEl)
            .setName('自定义标签')
            .setDesc('需要添加的标签文本 (如 #memo)')
            .addText(text => text
                .setValue(this.plugin.settings.customTag)
                .onChange(async (value) => {
                    this.plugin.settings.customTag = value;
                    await this.plugin.saveSettings();
                }));

        // --- [新增] 排除标签设置 ---
        new Setting(containerEl)
            .setName('排除标签')
            .setDesc('包含以下标签的 Memos 将不会被同步到 Obsidian。每行一个标签，例如：#private')
            .addTextArea(text => {
                text
                    .setPlaceholder('#private\n#draft')
                    .setValue(this.plugin.settings.excludeTags.join('\n'))
                    .onChange(async (value) => {
                        // 将输入文本按行拆分，并过滤空行
                        const tags = value.split('\n').map(t => t.trim()).filter(t => t.length > 0);
                        this.plugin.settings.excludeTags = tags;
                        await this.plugin.saveSettings();
                    });
                // 设置文本框高度，使其能显示多行
                text.inputEl.rows = 3;
            });

        new Setting(containerEl)
            .setName(t.t('USE_CALLOUT_FORMAT_NAME'))
            .setDesc(t.t('USE_CALLOUT_FORMAT_DESC'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useCalloutFormat)
                .onChange(async (value) => {
                    this.plugin.settings.useCalloutFormat = value;
                    if (value) this.plugin.settings.useListCalloutFormat = false;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(containerEl)
            .setName(t.t('USE_LIST_CALLOUT_FORMAT_NAME'))
            .setDesc(t.t('USE_LIST_CALLOUT_FORMAT_DESC'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useListCalloutFormat)
                .onChange(async (value) => {
                    this.plugin.settings.useListCalloutFormat = value;
                    if (value) this.plugin.settings.useCalloutFormat = false;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        if (this.plugin.settings.useListCalloutFormat) {
            const hint = containerEl.createEl('div', { cls: 'setting-item-description yet-another-memos-sync-callout-note' });
            hint.appendText('💡 为获得最佳视觉效果，建议安装 ');
            hint.createEl('strong', { text: 'List Callouts' });
            hint.appendText(' 插件，它可以根据 emoji 自动为列表添加颜色样式。');
        }

        new Setting(containerEl)
            .setName('跳过图片')
            .setDesc('同步时不包含图片资源，避免图片污染 Obsidian 库')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.skipImages)
                .onChange(async (value) => {
                    this.plugin.settings.skipImages = value;
                    await this.plugin.saveSettings();
                }));
    }

    private renderAutoSyncSection(containerEl: HTMLElement): void {
        new Setting(containerEl).setName(t.t('AUTO_SYNC_TITLE')).setHeading();
        new Setting(containerEl)
            .setName(t.t('AUTO_SYNC_STARTUP_NAME'))
            .setDesc(t.t('AUTO_SYNC_STARTUP_DESC'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableAutoSyncOnStartup)
                .onChange(async (value) => {
                    this.plugin.settings.enableAutoSyncOnStartup = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t.t('STARTUP_DELAY_NAME'))
            .setDesc(t.t('STARTUP_DELAY_DESC'))
            .addText(text => text
                .setPlaceholder('3')
                .setValue(String(this.plugin.settings.startupSyncDelay))
                .onChange(async (value) => {
                    this.plugin.settings.startupSyncDelay = Number(value) || 3;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t.t('SKIP_IF_SYNCED_NAME'))
            .setDesc(t.t('SKIP_IF_SYNCED_DESC'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.skipIfSyncedToday)
                .onChange(async (value) => {
                    this.plugin.settings.skipIfSyncedToday = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t.t('PERIODIC_SYNC_NAME'))
            .setDesc(t.t('PERIODIC_SYNC_DESC'))
            .addText(text => text
                .setPlaceholder('0')
                .setValue(String(this.plugin.settings.periodicSyncInterval))
                .onChange(async (value) => {
                    this.plugin.settings.periodicSyncInterval = Number(value) || 0;
                    await this.plugin.saveSettings();
                }));
    }

    // --- [新增] 渲染高级设置区域 ---
    private renderAdvancedSection(containerEl: HTMLElement): void {
        new Setting(containerEl).setName('高级设置').setHeading();

        new Setting(containerEl)
            .setName('调试模式')
            .setDesc('开启后，控制台将打印详细的同步日志，便于排查问题。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.debugMode)
                .onChange(async (value) => {
                    this.plugin.settings.debugMode = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('状态文件存储路径')
            .setDesc('自定义同步状态文件的存储路径（留空使用默认路径）。修改此路径相当于重置同步状态。')
            .addText(text => text
                .setPlaceholder('.memos_sync/sync-state.json')
                .setValue(this.plugin.settings.syncStateFilePath)
                .onChange(async (value) => {
                    this.plugin.settings.syncStateFilePath = value;
                    await this.plugin.saveSettings();
                    // 提示用户路径已更改，需要重启插件或触发重新加载以生效
                    new Notice('状态文件路径已修改，将在下次同步时生效。');
                }));

        // 显示同步状态统计信息
        const lastSyncTime = this.plugin.syncStateManager.getLastSyncTime();
        const syncedCount = this.plugin.syncStateManager.getSyncedMemoCount();
        new Setting(containerEl)
            .setName('同步状态统计')
            .setDesc(`最后同步: ${lastSyncTime ? new Date(lastSyncTime).toLocaleString() : '从未同步'}\n已同步 Memo 数量: ${syncedCount}`);

        new Setting(containerEl)
            .setName('重置同步状态')
            .setDesc('清空所有同步记录，下次同步将重新全量拉取所有 Memo。此操作不可逆。')
            .addButton(button => button
                .setButtonText('重置')
                .setWarning()
                .onClick(() => {
                    new ConfirmModal(this.app, '确定要重置所有同步状态吗？这将导致下一次同步变慢。', async () => {
                        await this.plugin.syncStateManager.reset();
                        new Notice('同步状态已重置！');
                        // 刷新设置界面以更新统计信息
                        this.display();
                    }).open();
                }));
    }
}
