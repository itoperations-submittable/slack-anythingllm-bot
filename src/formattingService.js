// src/formattingService.js
// This service will contain functions related to text extraction, splitting, and Slack formatting, moved from utils.js. 

import slackifyMarkdown from 'slackify-markdown';
import {
    MAX_SLACK_BLOCK_TEXT_LENGTH,
    MAX_SLACK_BLOCK_CODE_LENGTH
} from './config.js'; // Import necessary config values

// --- Smart Message Splitting ---

// Helper function
function splitByCharCount(text, maxLength) {
    const chunks = [];
    let remainingText = text; // Don't trim upfront, preserve initial formatting
    let isFirstChunk = true;

    while (remainingText.length > 0) {
        let currentChunk;
        if (remainingText.length <= maxLength) {
            currentChunk = remainingText;
            remainingText = ''; // End loop
        } else {
            // Find the last space within maxLength
            let splitPoint = remainingText.lastIndexOf(' ', maxLength);

            // If no space found, or space is very early, consider newline or force split
            if (splitPoint === -1 || splitPoint < maxLength / 2) {
                 let newlineSplitPoint = remainingText.lastIndexOf('\n', maxLength);
                 if (newlineSplitPoint !== -1 && newlineSplitPoint > 0) {
                     splitPoint = newlineSplitPoint + 1; // Split *after* the newline
                 } else {
                    splitPoint = maxLength; // Force split if no space/newline
                 }
            }
            
            currentChunk = remainingText.substring(0, splitPoint);
            remainingText = remainingText.substring(splitPoint);
        }

        // Trim chunk unless it's the first chunk AND ends with a newline (to preserve code block start)
        if (isFirstChunk && currentChunk.endsWith('\n')) {
             chunks.push(currentChunk); // Keep trailing newline for first chunk
        } else {
             chunks.push(currentChunk.trim()); // Trim subsequent chunks
        }
        isFirstChunk = false;
        remainingText = remainingText.trimStart(); // Trim leading space/newlines for the next chunk
    }
    return chunks;
}

export function splitMessageIntoChunks(message, maxLength = MAX_SLACK_BLOCK_TEXT_LENGTH) {
    if (!message || message.trim().length === 0) return [''];

    const segments = extractTextAndCode(message);
    if (segments.length === 0) return [''];

    const finalChunks = [];
    let currentTextChunk = ''; // Accumulates text between code blocks

    function flushCurrentTextChunk() {
        if (currentTextChunk.trim().length > 0) {
            finalChunks.push(...splitByCharCount(currentTextChunk, maxLength));
        }
        currentTextChunk = '';
    }

    for (const segment of segments) {
        if (segment.type === 'code') {
            // Flush any preceding text first
            flushCurrentTextChunk();

            // Only add language identifier if it's not the default 'text'
            const langIdentifier = (segment.language && segment.language !== 'text') ? segment.language : '';
            const codeBlockText = '```' + langIdentifier + '\n' + segment.content + '```';
            
            const limitForThisCodeBlock = MAX_SLACK_BLOCK_CODE_LENGTH > maxLength ? MAX_SLACK_BLOCK_CODE_LENGTH : maxLength;

            if (codeBlockText.length <= limitForThisCodeBlock) {
                 if (codeBlockText.length <= maxLength) {
                    finalChunks.push(codeBlockText); // Add as single chunk
                 } else {
                    finalChunks.push(...splitByCharCount(codeBlockText, maxLength));
                 }
            } else {
                 console.log(`[Formatting Service] Large code block (${codeBlockText.length} chars > ${limitForThisCodeBlock}) will be split by code limit`);
                finalChunks.push(...splitByCharCount(codeBlockText, limitForThisCodeBlock));
            }

        } else { // segment.type === 'text'
            if (currentTextChunk.length > 0) {
                 currentTextChunk += ' '; 
            }
            currentTextChunk += segment.content;
        }
    }

    flushCurrentTextChunk();

    if (finalChunks.length > 1) {
        const nonEmptyChunks = finalChunks.filter(chunk => chunk && chunk.trim().length > 0);
        let nonCodeBlockCounter = 0;
        const totalNonCodeBlocks = nonEmptyChunks.filter(chunk => !chunk.trim().startsWith('```')).length;
        
        if (nonEmptyChunks.length > 1 && totalNonCodeBlocks > 1) { 
            return nonEmptyChunks.map((chunk) => {
                if (!chunk.trim().startsWith('```')) {
                    nonCodeBlockCounter++;
                    return `[${nonCodeBlockCounter}/${totalNonCodeBlocks}] ${chunk}`;
                }
                return chunk;
            });
        } else {
             return nonEmptyChunks;
        }
    }

    const finalNonEmpty = finalChunks.filter(chunk => chunk && chunk.trim().length > 0);
    return finalNonEmpty.length > 0 ? finalNonEmpty : [''];
}

// --- Text and Code Extraction ---

const languageToFiletypeMap = {
    'javascript': 'javascript', 'js': 'javascript',
    'typescript': 'typescript', 'ts': 'typescript',
    'python': 'python', 'py': 'python',
    'php': 'php',
    'java': 'java',
    'csharp': 'csharp', 'cs': 'csharp',
    'cpp': 'cpp', 'c++': 'cpp',
    'ruby': 'ruby', 'rb': 'ruby',
    'swift': 'swift',
    'kotlin': 'kotlin', 'kt': 'kotlin',
    'go': 'go', 'golang': 'go',
    'rust': 'rust', 'rs': 'rust',
    'html': 'html',
    'css': 'css',
    'json': 'json',
    'yaml': 'yaml', 'yml': 'yaml',
    'markdown': 'markdown', 'md': 'markdown',
    'sql': 'sql',
    'shell': 'shell', 'bash': 'shell', 'sh': 'shell',
    'plaintext': 'text', 'text': 'text',
    'diff': 'diff',
    'dockerfile': 'dockerfile',
};

export function extractTextAndCode(rawText) {
    if (!rawText) return [];

    const segments = [];
    const codeBlockRegex = /^``` *(\w+)? *\n([\s\S]*?)^```$/gm;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(rawText)) !== null) {
        const languageIdentifier = match[1]?.toLowerCase() || 'text';
        const codeContent = match[2];
        const startIndex = match.index;
        const endIndex = codeBlockRegex.lastIndex;

        if (startIndex > lastIndex) {
            segments.push({
                type: 'text',
                content: rawText.substring(lastIndex, startIndex).trim()
            });
        }
        segments.push({
            type: 'code',
            content: codeContent,
            language: languageIdentifier
        });
        lastIndex = endIndex;
    }
    if (lastIndex < rawText.length) {
        segments.push({
            type: 'text',
            content: rawText.substring(lastIndex).trim()
        });
    }
    return segments.filter(segment => segment.type === 'code' || segment.content.length > 0);
}

export function getSlackFiletype(language) {
    return languageToFiletypeMap[language?.toLowerCase()] || 'text'; // Default to 'text'
}

// --- Slack Rich Text Block Conversion ---

/**
 * Parses inline markdown formatting (bold, code, links) and adds appropriate elements
 * to the elements array. ITALICS ARE IGNORED.
 */
function parseInlineFormatting(text, elements) {
    let currentText = '';
    let i = 0;
    
    while (i < text.length) {
        if ((text[i] === '*' && text[i+1] === '*') || (text[i] === '_' && text[i+1] === '_')) {
            if (currentText) elements.push({ "type": "text", "text": currentText });
            currentText = '';
            const marker = text[i];
            i += 2;
            let boldText = '';
            while (i < text.length && !(text[i] === marker && text[i+1] === marker)) {
                boldText += text[i++];
            }
            if (boldText) elements.push({ "type": "text", "text": boldText, "style": { "bold": true }});
            i += 2;
        } else if (text[i] === '`') {
            if (currentText) elements.push({ "type": "text", "text": currentText });
            currentText = '';
            i++;
            let codeText = '';
            while (i < text.length && text[i] !== '`') {
                codeText += text[i++];
            }
            if (codeText) elements.push({ "type": "text", "text": codeText, "style": { "code": true }});
            i++;
        } else if (text[i] === '[') {
            if (currentText) elements.push({ "type": "text", "text": currentText });
            currentText = '';
            i++;
            let linkText = '';
            while (i < text.length && text[i] !== ']') {
                linkText += text[i++];
            }
            i++;
            if (i < text.length && text[i] === '(') {
                i++;
                let linkUrl = '';
                while (i < text.length && text[i] !== ')') {
                    linkUrl += text[i++];
                }
                if (linkText && linkUrl) elements.push({ "type": "link", "text": linkText, "url": linkUrl });
                i++;
            } else {
                 currentText += '[' + linkText + ']';
            }
        } else {
            if (text[i] === '*' || text[i] === '_') {
                 if (!((text[i+1] === text[i]) || (i + 1 >= text.length || /\s/.test(text[i+1])))) {
                     const marker = text[i++];
                     while (i < text.length && text[i] !== marker) {
                         currentText += text[i++];
                     }
                     if (i < text.length) i++;
                     continue;
                 }
            }
            currentText += text[i++];
        }
    }
    if (currentText) elements.push({ "type": "text", "text": currentText });
}

/**
 * Converts markdown text into a single Slack rich_text block containing one section or preformatted element.
 */
export function markdownToRichTextBlock(markdown, blockId = `block_${Date.now()}`) {
    if (!markdown) return null;

    let processedMarkdown = markdown.replace(/\\n\s*$/, '').replace(/\\\\n/g, '');
    const codeMatch = processedMarkdown.trim().match(/^```([\w]*)\n?([\s\S]*?)```$/);
    
    if (codeMatch && processedMarkdown.trim() === codeMatch[0].trim()) {
         const codeContent = codeMatch[2];
         console.log(`[Formatting Service] Detected pure code block, length: ${codeContent.length}. Using rich_text_preformatted.`);
         return {
             "type": "rich_text",
             "block_id": blockId,
             "elements": [{
                 "type": "rich_text_preformatted",
                 "elements": [{ "type": "text", "text": codeContent }]
             }]
         };
    } else {
        const sectionElements = [];
        processedMarkdown = processedMarkdown.replace(/\n/g, '\n\n'); // Add spacing for paragraphs
        console.log(`[Formatting Service] Parsing inline formatting for text block.`);
        parseInlineFormatting(processedMarkdown, sectionElements);

        if (sectionElements.length === 0) {
            console.log(`[Formatting Service] No elements generated, returning null.`);
            return null;
        }
        console.log(`[Formatting Service] Created single rich_text_section block.`);
        return {
            "type": "rich_text",
            "block_id": blockId,
            "elements": [{
                "type": "rich_text_section",
                "elements": sectionElements
            }]
        };
    }
} 