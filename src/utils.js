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
    
    // Determine if this is a code block (starts with triple backticks)
    const isCodeBlock = message.trim().startsWith('```');
    
    // Use appropriate threshold based on content type
    const effectiveMaxLength = isCodeBlock ? MAX_SLACK_BLOCK_CODE_LENGTH : maxLength;
    
    // If the message fits in one chunk, return it directly
    if (message.length <= effectiveMaxLength) {
        return [message];
    }
    
    const chunks = [];
    
    // First, check for code blocks and preserve them
    const codeBlockRegex = /```[\s\S]*?```/g;
    const codeBlocks = [];
    const textPieces = [];
    let lastIndex = 0;
    let match;
    
    // Extract code blocks and text pieces
    while ((match = codeBlockRegex.exec(message)) !== null) {
        const textBefore = message.substring(lastIndex, match.index).trim();
        if (textBefore) {
            textPieces.push({ type: 'text', content: textBefore });
        }
        
        codeBlocks.push({ type: 'code', content: match[0] });
        textPieces.push({ type: 'code', index: codeBlocks.length - 1 });
        
        lastIndex = match.index + match[0].length;
    }
    
    // Add the last text piece if it exists
    if (lastIndex < message.length) {
        const finalText = message.substring(lastIndex).trim();
        if (finalText) {
            textPieces.push({ type: 'text', content: finalText });
        }
    }
    
    // If there are no code blocks, use paragraph-based splitting with text threshold
    if (codeBlocks.length === 0) {
        return splitTextByLogicalBreaks(message, maxLength);
    }
    
    // Process text pieces and code blocks
    let currentChunk = '';
    const allPieces = textPieces;
    
    for (let i = 0; i < allPieces.length; i++) {
        const piece = allPieces[i];
        
        if (piece.type === 'text') {
            // For text pieces, use the regular text threshold
            const textMaxLength = MAX_SLACK_BLOCK_TEXT_LENGTH;
            const textToAdd = piece.content;
            
            if (currentChunk.length + textToAdd.length <= textMaxLength) {
                // Text fits in the current chunk
                currentChunk += textToAdd;
            } else if (textToAdd.length > textMaxLength) {
                // Text is too long for a single chunk, needs its own splitting
                if (currentChunk) {
                    chunks.push(currentChunk);
                    currentChunk = '';
                }
                
                // Split the large text by paragraphs and logical breaks
                const textChunks = splitTextByLogicalBreaks(textToAdd, textMaxLength);
                chunks.push(...textChunks.slice(0, -1));
                currentChunk = textChunks[textChunks.length - 1] || '';
            } else {
                // Text doesn't fit in current chunk but fits in its own chunk
                chunks.push(currentChunk);
                currentChunk = textToAdd;
            }
        } else if (piece.type === 'code') {
            // For code blocks, use the code threshold to preserve format
            const codeMaxLength = MAX_SLACK_BLOCK_CODE_LENGTH;
            const codeBlock = codeBlocks[piece.index];
            
            if (currentChunk.length + codeBlock.content.length <= codeMaxLength) {
                // Code block fits in current chunk
                currentChunk += codeBlock.content;
            } else {
                // Start a new chunk for the code block
                if (currentChunk) {
                    chunks.push(currentChunk);
                }
                
                if (codeBlock.content.length <= codeMaxLength) {
                    // Code block fits in its own chunk
                    currentChunk = codeBlock.content;
                } else {
                    // Code block is too large for a single chunk
                    // We still keep it intact to avoid breaking code
                    chunks.push(codeBlock.content);
                    currentChunk = '';
                }
            }
        }
        
        // Add a space between pieces
        if (i < allPieces.length - 1 && currentChunk) {
            currentChunk += ' ';
        }
    }
    
    // Add the last chunk if not empty
    if (currentChunk) {
        chunks.push(currentChunk);
    }
    
    // Add section indicators if there are multiple chunks
    if (chunks.length > 1) {
        const numberedChunks = chunks.map((chunk, index) => {
            // Only add section indicators to non-code chunks
            if (!chunk.trim().startsWith('```')) {
                return `[${index + 1}/${chunks.length}] ${chunk}`;
            }
            return chunk;
        });
        
        // Final length check but respect type-specific thresholds
        return numberedChunks.flatMap(chunk => {
            const isChunkCode = chunk.trim().startsWith('```');
            const chunkMaxLength = isChunkCode ? MAX_SLACK_BLOCK_CODE_LENGTH : MAX_SLACK_BLOCK_TEXT_LENGTH;
            
            if (chunk.length <= chunkMaxLength) {
                return [chunk];
            } else if (isChunkCode) {
                // For code blocks, keep them intact even if they're long
                console.log(`[Utils] Code block exceeds threshold (${chunk.length} > ${chunkMaxLength}), but keeping intact`);
                return [chunk];
            } else {
                console.warn(`[Utils] Text chunk exceeds threshold (${chunk.length} > ${chunkMaxLength}), forcing split`);
                return splitByCharCount(chunk, chunkMaxLength);
            }
        });
    }
    
    // One last check with type-specific thresholds
    return chunks.flatMap(chunk => {
        const isChunkCode = chunk.trim().startsWith('```');
        const chunkMaxLength = isChunkCode ? MAX_SLACK_BLOCK_CODE_LENGTH : MAX_SLACK_BLOCK_TEXT_LENGTH;
        
        if (chunk.length <= chunkMaxLength) {
            return [chunk];
        } else if (isChunkCode) {
            // For code blocks, keep them intact
            return [chunk];
        } else {
            return splitByCharCount(chunk, chunkMaxLength);
        }
    });
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
         return slackifyMarkdown(processedText);
     } catch (conversionError) {
         console.error("[Utils] Error converting text segment with slackify-markdown, using original:", conversionError);
         // Fallback to the original text if slackify fails
         return textSegment;
     }
}
