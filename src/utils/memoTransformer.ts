import { moment } from 'obsidian';
import { getSafeFilename } from './resourceUtils'; // 引入公共逻辑

function getTimeEmoji(hour: number): string {
    if (hour >= 5 && hour < 12) return '🌅';
    if (hour >= 12 && hour < 17) return '☀️';
    if (hour >= 17 && hour < 21) return '🌆';
    return '🌙';
}

function getTimeCalloutType(hour: number): string {
    if (hour >= 5 && hour < 12) return 'info';
    if (hour >= 12 && hour < 17) return 'tip';
    if (hour >= 17 && hour < 21) return 'warning';
    return 'note';
}

function getTimePeriodName(hour: number): string {
    if (hour >= 5 && hour < 12) return '早晨';
    if (hour >= 12 && hour < 17) return '中午';
    if (hour >= 17 && hour < 21) return '傍晚';
    return '夜晚';
}

/**
 * 清理多余的空行，保持内容紧凑
 */
function cleanExcessLines(text: string): string {
    // 移除 Windows 换行符
    text = text.replace(/\r\n/g, '\n');
    // 将连续多个换行符替换为一个
    text = text.replace(/\n{2,}/g, '\n');
    // 移除每行首尾空白（保留换行结构）
    const lines = text.split('\n').map(line => line.trim());
    return lines.join('\n');
}

/**
 * 将 Memo 转换为 Obsidian Markdown 格式
 * 注意：此函数只负责内容格式化，不负责添加 ID
 */
export function transformMemoToMarkdown(
    memo: { timestamp: number; content: string; resources: any[] },
    useCalloutFormat: boolean,
    useListCalloutFormat: boolean,
    skipImages: boolean,
    showEmoji: boolean,
    tagMode: 'none' | 'smart' | 'always',
    customTag: string
): { date: string; timestamp: string; content: string } {
    const { timestamp, content, resources } = memo;
    const m = moment(timestamp * 1000);
    const dateStr = m.format('YYYY-MM-DD');
    const timeStr = m.format('HH:mm');
    const hour = m.hour();

    const emoji = showEmoji ? `${getTimeEmoji(hour)} ` : '';

    // 过滤资源
    const targetResources = skipImages ? resources.filter(r => !(r.type && r.type.includes('image'))) : resources;

    // 生成资源 Markdown 链接
    const resourceMarkdown = targetResources.map(res => {
        if (res.type && res.type.includes('image')) {
            return `![[${getSafeFilename(res)}]]`;
        }
        return res.externalLink ? `[${res.filename || 'resource'}](${res.externalLink})` : `![[${getSafeFilename(res)}]]`;
    });

    // 处理标签
    let tagText = '';
    if (tagMode === 'always' || (tagMode === 'smart' && !content.includes('#'))) {
        tagText = ` ${customTag}`;
    }

    // --- 核心格式化逻辑 ---
    let body = '';

    // 1. 清理内容中的多余空行
    const cleanContent = cleanExcessLines(content || '');
    const contentLines = cleanContent.split('\n');

    if (useCalloutFormat) {
        const calloutType = getTimeCalloutType(hour);
        // Callout 内部不需要缩进，直接使用原始换行
        const formattedContent = contentLines.map(l => `> ${l}`).join('\n');
        const resLines = resourceMarkdown.map(l => `> ${l}`).join('\n');
        body = `> [!${calloutType}] ${emoji}${timeStr} - ${getTimePeriodName(hour)}\n${formattedContent}\n${resLines}`;
    } else if (useListCalloutFormat) {
        // 单行模式
        const line = `- ${emoji}${timeStr} ${contentLines.join(' ')}${tagText}`;
        const resLines = resourceMarkdown.map(l => `  ${l}`).join('\n');
        body = resLines ? `${line}\n${resLines}` : line;
    } else {
        // 标准列表模式 (适配你的习惯)
        // 第一行：- HH:mm Content
        const firstLine = contentLines.shift();
        let result = `- ${emoji}${timeStr} ${firstLine}${tagText}`;
        
        // 后续行：缩进两个空格
        if (contentLines.length > 0) {
            result += '\n' + contentLines.map(l => `  ${l}`).join('\n');
        }
        
        // 资源：缩进两个空格
        if (resourceMarkdown.length > 0) {
            result += '\n' + resourceMarkdown.map(l => `  ${l}`).join('\n');
        }
        body = result;
    }

    return { date: dateStr, timestamp: String(timestamp), content: body };
}
