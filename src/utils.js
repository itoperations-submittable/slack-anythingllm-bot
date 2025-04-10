import slackifyMarkdown from 'slackify-markdown';
import {
    isRedisReady, redisClient // Correct: Import only client and status from services
} from './services.js';
import {
    redisUrl, // Correct: Import URL from config
    DUPLICATE_EVENT_REDIS_PREFIX,
    DUPLICATE_EVENT_TTL,
    MAX_SLACK_BLOCK_TEXT_LENGTH,
    MAX_SLACK_BLOCK_CODE_LENGTH
} from './config.js';

// --- Event Deduplication ---

// Function to check for duplicate events using Redis
export async function isDuplicateRedis(eventId) {
    if (!redisUrl || !isRedisReady) { return false; } // Feature disabled if Redis isn't configured/ready
    const key = `${DUPLICATE_EVENT_REDIS_PREFIX}${eventId}`;
    try {
        // SET NX (set if not exists) with EX (expiration) is atomic
        const result = await redisClient.set(key, '1', { NX: true, EX: DUPLICATE_EVENT_TTL });
        return result === null; // If null, key already existed
    } catch (error) {
        console.error(`[Redis Deduplication Error] Failed operation for key ${key}:`, error);
        return false; // Fail open (assume not duplicate) if Redis fails
    }
}

// --- Smart Message Splitting ---
export function splitMessageIntoChunks(message, maxLength) {
    if (!message) return [''];
    
    // If the message fits in one chunk, return it directly
    if (message.length <= maxLength) {
        return [message];
    }
    
    // Simple chunking - just handle code blocks as special cases
    const chunks = [];
    
    // Parse the message to extract code blocks and text segments
    const segments = extractTextAndCode(message);
    
    // Process each segment
    for (const segment of segments) {
        if (segment.type === 'code') {
            // For code blocks, try to keep intact if possible
            const codeBlockText = '```' + (segment.language || '') + '\n' + segment.content + '```';
            
            if (codeBlockText.length <= MAX_SLACK_BLOCK_CODE_LENGTH) {
                // Code block fits within limits, add it as a single chunk
                chunks.push(codeBlockText);
            } else {
                // Code block is too large, split by character
                console.log(`[Utils] Large code block (${codeBlockText.length} chars) will be split`);
                
                // Just split the code block at the character limit
                // This might break code but is necessary for extremely large blocks
                chunks.push(...splitByCharCount(codeBlockText, MAX_SLACK_BLOCK_CODE_LENGTH));
            }
        } else {
            // For text segments, split by character count
            if (segment.content.length <= MAX_SLACK_BLOCK_TEXT_LENGTH) {
                chunks.push(segment.content);
            } else {
                chunks.push(...splitByCharCount(segment.content, MAX_SLACK_BLOCK_TEXT_LENGTH));
            }
        }
    }
    
    // Add section numbers if there are multiple chunks
    if (chunks.length > 1) {
        return chunks.map((chunk, index) => {
            if (!chunk.trim().startsWith('```')) {
                return `[${index + 1}/${chunks.length}] ${chunk}`;
            }
            return chunk;
        });
    }
    
    return chunks;
}

/**
 * Helper function to split text by logical breaks like paragraphs and headings
 */
function splitTextByLogicalBreaks(text, maxLength) {
    const chunks = [];
    
    // Identify logical break points (paragraphs, headings, lists)
    const breakPatterns = [
        /\n\s*\n/g,           // Double line breaks (paragraphs)
        /\n#{1,6}\s+[^\n]+/g, // Markdown headings
        /\n\s*[-*+]\s+/g,     // Unordered list items
        /\n\s*\d+\.\s+/g,     // Ordered list items
        /\n\s*>/g,            // Blockquotes
    ];
    
    // Split by logical breaks first
    const breakPoints = [];
    breakPatterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            breakPoints.push(match.index);
        }
    });
    
    // Sort break points in ascending order
    breakPoints.sort((a, b) => a - b);
    
    // If no break points found, fall back to character-based splitting
    if (breakPoints.length === 0) {
        return splitByCharCount(text, maxLength);
    }
    
    // Split text using the identified break points
    let startIndex = 0;
    let currentChunk = '';
    
    for (let i = 0; i < breakPoints.length; i++) {
        const breakPoint = breakPoints[i];
        const nextSection = text.substring(startIndex, breakPoint + 1); // +1 to include the newline
        
        if (currentChunk.length + nextSection.length <= maxLength) {
            currentChunk += nextSection;
        } else {
            // If the section doesn't fit, check if current chunk has content
            if (currentChunk.length > 0) {
                chunks.push(currentChunk.trim());
            }
            
            // Check if the next section is too large for a single chunk
            if (nextSection.length > maxLength) {
                // If a single section is too large, split it by character
                const subChunks = splitByCharCount(nextSection, maxLength);
                chunks.push(...subChunks.slice(0, -1));
                currentChunk = subChunks[subChunks.length - 1] || '';
            } else {
                currentChunk = nextSection;
            }
        }
        
        startIndex = breakPoint + 1;
    }
    
    // Add the final section
    if (startIndex < text.length) {
        const finalSection = text.substring(startIndex);
        
        if (currentChunk.length + finalSection.length <= maxLength) {
            currentChunk += finalSection;
        } else {
            if (currentChunk.length > 0) {
                chunks.push(currentChunk.trim());
            }
            
            if (finalSection.length > maxLength) {
                chunks.push(...splitByCharCount(finalSection, maxLength));
                currentChunk = '';
            } else {
                currentChunk = finalSection;
            }
        }
    }
    
    // Add the last chunk if it's not empty
    if (currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
    }
    
    return chunks;
}

/**
 * Helper function to split text by character count as a last resort
 */
function splitByCharCount(text, maxLength) {
    const chunks = [];
    let remainingText = text;
    
    while (remainingText.length > 0) {
        if (remainingText.length <= maxLength) {
            chunks.push(remainingText);
            break;
        }
        
        // Try to find a natural break point (space, period, etc.)
        let splitPoint = remainingText.lastIndexOf(' ', maxLength);
        if (splitPoint === -1 || splitPoint < maxLength / 2) {
            // If no good break point, try punctuation
            const punctuation = remainingText.substring(0, maxLength).search(/[.!?;:,]\s/);
            if (punctuation !== -1 && punctuation > maxLength / 2) {
                splitPoint = punctuation + 1; // Include the punctuation
            } else {
                // If still no good break, just split at max length
                splitPoint = maxLength;
            }
        }
        
        chunks.push(remainingText.substring(0, splitPoint).trim());
        remainingText = remainingText.substring(splitPoint).trim();
    }
    
    return chunks;
}

// --- Text and Code Extraction ---

/**
 * Maps common language identifiers to Slack filetypes.
 * Add more mappings as needed.
 */
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

/**
 * Splits raw LLM text into an array of text and code segments.
 * @param {string} rawText - The raw text from the LLM.
 * @returns {Array<{type: 'text' | 'code', content: string, language?: string}>}
 */
export function extractTextAndCode(rawText) {
    if (!rawText) return [];

    const segments = [];
    // Regex to find code blocks, capturing optional language and content
    // Allows for optional spaces around language identifier
    const codeBlockRegex = /^``` *(\w+)? *\n([\s\S]*?)^```$/gm;

    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(rawText)) !== null) {
        const languageIdentifier = match[1]?.toLowerCase() || 'text'; // Default to 'text' if no language
        const codeContent = match[2];
        const startIndex = match.index;
        const endIndex = codeBlockRegex.lastIndex;

        // Add preceding text segment if it exists
        if (startIndex > lastIndex) {
            segments.push({
                type: 'text',
                content: rawText.substring(lastIndex, startIndex).trim() // Trim whitespace from text segments
            });
        }

        // Add the code block segment
        segments.push({
            type: 'code',
            content: codeContent,
            language: languageIdentifier // Store the identifier used by LLM
        });

        lastIndex = endIndex;
    }

    // Add any remaining text after the last code block
    if (lastIndex < rawText.length) {
        segments.push({
            type: 'text',
            content: rawText.substring(lastIndex).trim()
        });
    }

    // Filter out empty text segments that might result from trimming
    return segments.filter(segment => segment.type === 'code' || segment.content.length > 0);
}

/**
 * Gets the corresponding Slack filetype for a language identifier.
 * @param {string} language - The language identifier (e.g., 'javascript', 'php').
 * @returns {string} The Slack filetype (e.g., 'javascript', 'php', 'text').
 */
export function getSlackFiletype(language) {
    return languageToFiletypeMap[language?.toLowerCase()] || 'text'; // Default to 'text'
}


// --- Slack Markdown Conversion (Simplified) ---
// This function now ONLY handles basic markdown conversion for *text* segments.
// Code blocks are handled separately.
export function formatSlackMessage(textSegment) {
     if (!textSegment) return '';

     // Log the input to see if code blocks are present
     const hasCodeBlock = textSegment.includes('```');
     console.log(`[Utils/formatSlackMessage] Input has code block: ${hasCodeBlock}, Length: ${textSegment.length}, First 30 chars: "${textSegment.substring(0, 30)}..."`);

     try {
         // STEP 1: Pre-process to remove language identifiers from code blocks
         // This helps slackify-markdown to properly handle code blocks
         let processedText = textSegment.replace(/^```(\w+)\n/gm, '```\n');
         
         // STEP 2: Add proper spacing around code fences for better rendering
         processedText = processedText.replace(/^```\n(?!\n)/gm, '```\n\n');
         processedText = processedText.replace(/(?<!\n)\n```$/gm, '\n\n```');
         
         // STEP 3: Remove any escaped newlines that might be at the end
         processedText = processedText.replace(/\\n\s*$/, '');
         
         // STEP 4: Remove any double-escaped newlines anywhere in the text
         processedText = processedText.replace(/\\\\n/g, '');

         // Convert the pre-processed Markdown text to Slack mrkdwn 
         const result = slackifyMarkdown(processedText);
         console.log(`[Utils/formatSlackMessage] Output after processing, Length: ${result.length}, First 30 chars: "${result.substring(0, 30)}..."`);
         return result;
     } catch (conversionError) {
         console.error("[Utils] Error converting text segment with slackify-markdown, using original:", conversionError);
         // Fallback to the original text if slackify fails
         return textSegment;
     }
}

/**
 * Converts markdown text into a single Slack rich_text block containing one section.
 * Parses inline formatting within that section.
 * @param {string} markdown - Markdown text to convert
 * @param {string} [blockId] - Optional block ID
 * @returns {object | null} - A single Slack rich_text block, or null if input is empty.
 */
export function markdownToRichTextBlock(markdown, blockId = `block_${Date.now()}`) {
    if (!markdown) return null;

    // Process the markdown to ensure clean formatting
    let processedMarkdown = markdown;
    
    // Remove escaped newlines at the end
    processedMarkdown = processedMarkdown.replace(/\\n\s*$/, '');
    
    // Remove any double-escaped newlines
    processedMarkdown = processedMarkdown.replace(/\\\\n/g, '');
    
    // Replace double newlines (paragraphs) with single newlines initially
    processedMarkdown = processedMarkdown.replace(/\n\n+/g, '\n'); 
    
    console.log(`[Utils/markdownToRichTextBlock] Processing markdown for single section, length: ${processedMarkdown.length}`);

    const sectionElements = [];
    
    // Special handling for pure code blocks 
    const codeMatch = processedMarkdown.trim().match(/^```([\w]*)\n?([\s\S]*?)```$/);
    
    // Check if the entire input matches the fenced code block pattern
    if (codeMatch && processedMarkdown.trim() === codeMatch[0].trim()) {
         const codeContent = codeMatch[2];
         console.log(`[Utils/markdownToRichTextBlock] Detected pure code block, length: ${codeContent.length}. Using rich_text_preformatted.`);
         
         // --- Return a block with rich_text_preformatted --- 
         const preformattedBlock = {
             "type": "rich_text",
             "block_id": blockId,
             "elements": [{
                 "type": "rich_text_preformatted",
                 "elements": [{
                     "type": "text",
                     "text": codeContent // The raw code content
                 }]
                 // Note: Slack doesn't officially support border or language hints here
             }]
         };
         console.log(`[Utils] Created single rich_text_preformatted block.`);
         return preformattedBlock;
         // --- End preformatted block --- 
         
    } else {
        // For non-code blocks, try adding extra newlines for spacing
        console.log(`[Utils/markdownToRichTextBlock] Adding double newlines for potential spacing.`);
        processedMarkdown = processedMarkdown.replace(/\n/g, '\n\n'); 
        
        // Parse the entire processed text for inline formatting
        console.log(`[Utils/markdownToRichTextBlock] Parsing inline formatting for text block.`);
        parseInlineFormatting(processedMarkdown, sectionElements);
    }

    // Only create block if elements were generated
    if (sectionElements.length === 0) {
        console.log(`[Utils/markdownToRichTextBlock] No elements generated, returning null.`);
        return null;
    }

    // Create the single rich_text block structure
    const richTextBlock = {
        "type": "rich_text",
        "block_id": blockId,
        "elements": [{
            "type": "rich_text_section",
            "elements": sectionElements
        }]
    };
    
    console.log(`[Utils] Created single rich_text_section block.`);
    return richTextBlock;
}

/**
 * Parses inline markdown formatting (bold, code, links) and adds appropriate elements
 * to the elements array. ITALICS ARE IGNORED.
 * @param {string} text - The text to parse
 * @param {Array} elements - The array to add elements to
 */
function parseInlineFormatting(text, elements) {
    // Simple regex pattern to match basic markdown
    // This is a simplified implementation and might need improvements for complex cases
    let currentText = '';
    let i = 0;
    
    while (i < text.length) {
        // Bold: **text** or __text__ (double markers only)
        if ((text[i] === '*' && text[i+1] === '*') || 
            (text[i] === '_' && text[i+1] === '_')) {
            
            // Push any accumulated regular text first
            if (currentText) {
                elements.push({ "type": "text", "text": currentText });
                currentText = '';
            }
            
            const marker = text[i];
            i += 2; // Skip the markers
            let boldText = '';
            
            // Find the closing marker
            while (i < text.length && 
                  !(text[i] === marker && text[i+1] === marker)) {
                boldText += text[i];
                i++;
            }
            
            // Add bold text element
            if (boldText) {
                elements.push({ 
                    "type": "text", 
                    "text": boldText,
                    "style": { "bold": true }
                });
            }
            
            i += 2; // Skip closing markers
        }
        // --- IGNORE ITALICS --- : *text* or _text_ (single marker)
        // else if (text[i] === '*' || text[i] === '_') { ... }
        
        // Inline code: `code`
        else if (text[i] === '`') {
            // Push any accumulated regular text first
            if (currentText) {
                elements.push({ "type": "text", "text": currentText });
                currentText = '';
            }
            
            i++; // Skip the backtick
            let codeText = '';
            
            // Find the closing backtick
            while (i < text.length && text[i] !== '`') {
                codeText += text[i];
                i++;
            }
            
            // Add code text element
            if (codeText) {
                elements.push({ 
                    "type": "text", 
                    "text": codeText,
                    "style": { "code": true }
                });
            }
            
            i++; // Skip closing backtick
        }
        // Simple link: [text](url)
        else if (text[i] === '[') {
            // Push any accumulated regular text first
            if (currentText) {
                elements.push({ "type": "text", "text": currentText });
                currentText = '';
            }
            
            i++; // Skip the opening bracket
            let linkText = '';
            
            // Find the closing bracket
            while (i < text.length && text[i] !== ']') {
                linkText += text[i];
                i++;
            }
            
            i++; // Skip closing bracket
            
            // Check for link URL
            if (i < text.length && text[i] === '(') {
                i++; // Skip the opening parenthesis
                let linkUrl = '';
                
                // Find the closing parenthesis
                while (i < text.length && text[i] !== ')') {
                    linkUrl += text[i];
                    i++;
                }
                
                // Add link element
                if (linkText && linkUrl) {
                    elements.push({ 
                        "type": "link", 
                        "text": linkText,
                        "url": linkUrl
                    });
                }
                
                i++; // Skip closing parenthesis
            } else {
                 // Handle case where it looked like a link but wasn't, treat as text
                 currentText += '[' + linkText + ']';
                 // Don't increment i here, let the outer loop handle the character after ']'
            }
        }
        // Regular text
        else {
            // Handle potential single * or _ that are not part of formatting
            if (text[i] === '*' || text[i] === '_') {
                 // Check if it's NOT followed by the same marker (already handled by bold)
                 // or whitespace/end of string (likely just punctuation)
                 if (!((text[i+1] === text[i]) || 
                       (i + 1 >= text.length || /\s/.test(text[i+1])))) {
                     // This looks like the start of an *ignored* italic block
                     const marker = text[i];
                     i++; // Consume the marker
                     // Keep consuming until the closing marker or end of text
                     while (i < text.length && text[i] !== marker) {
                         currentText += text[i];
                         i++;
                     }
                     if (i < text.length) {
                         i++; // Consume the closing marker
                     }
                     continue; // Restart loop iteration
                 }
            }
            currentText += text[i];
            i++;
        }
    }
    
    // Add any remaining text
    if (currentText) {
        elements.push({ "type": "text", "text": currentText });
    }
}
