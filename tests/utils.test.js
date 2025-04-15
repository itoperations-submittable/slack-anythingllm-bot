import { extractTextAndCode, getSlackFiletype, splitMessageIntoChunks } from '../src/utils.js';

describe('Utils Tests', () => {
  describe('extractTextAndCode', () => {
    test('should extract text and a single code block', () => {
      const rawText = 'This is some text.\n```javascript\nconsole.log("Hello");\n```\nMore text.';
      const expected = [
        { type: 'text', content: 'This is some text.' },
        { type: 'code', content: 'console.log("Hello");\n', language: 'javascript' },
        { type: 'text', content: 'More text.' }
      ];
      expect(extractTextAndCode(rawText)).toEqual(expected);
    });

    test('should handle text only', () => {
      const rawText = 'Just plain text here.';
      const expected = [
        { type: 'text', content: 'Just plain text here.' }
      ];
      expect(extractTextAndCode(rawText)).toEqual(expected);
    });

    test('should handle code block only with language', () => {
      const rawText = '```python\nprint("Hello")\n```';
      const expected = [
        { type: 'code', content: 'print("Hello")\n', language: 'python' }
      ];
      expect(extractTextAndCode(rawText)).toEqual(expected);
    });

    test('should handle code block only without language', () => {
      const rawText = '```\nsome code\n```';
      const expected = [
        { type: 'code', content: 'some code\n', language: 'text' } // Defaults to text
      ];
      expect(extractTextAndCode(rawText)).toEqual(expected);
    });

    test('should handle multiple code blocks', () => {
      const rawText = 'Intro.\n```js\nlet x = 1;\n```\nMiddle.\n```\nplain code\n```\nOutro.';
      const expected = [
        { type: 'text', content: 'Intro.' },
        { type: 'code', content: 'let x = 1;\n', language: 'js' },
        { type: 'text', content: 'Middle.' },
        { type: 'code', content: 'plain code\n', language: 'text' },
        { type: 'text', content: 'Outro.' }
      ];
      expect(extractTextAndCode(rawText)).toEqual(expected);
    });

    test('should handle empty input string', () => {
      const rawText = '';
      const expected = [];
      expect(extractTextAndCode(rawText)).toEqual(expected);
    });

    test('should handle input with only whitespace', () => {
      const rawText = '   \n  \t ';
      // Whitespace outside code blocks is trimmed, so effectively empty
      const expected = []; 
      expect(extractTextAndCode(rawText)).toEqual(expected);
    });

    test('should handle code block at the beginning', () => {
       const rawText = '```php\necho "hi";\n```\nSome text afterwards.';
       const expected = [
         { type: 'code', content: 'echo "hi";\n', language: 'php' },
         { type: 'text', content: 'Some text afterwards.' }
       ];
       expect(extractTextAndCode(rawText)).toEqual(expected);
    });

     test('should handle code block with extra whitespace around language', () => {
      const rawText = '```  javascript   \nconsole.log("Spacing");\n```';
      const expected = [
        { type: 'code', content: 'console.log("Spacing");\n', language: 'javascript' }
      ];
      expect(extractTextAndCode(rawText)).toEqual(expected);
    });

  });

  // --- Tests for getSlackFiletype --- 
  describe('getSlackFiletype', () => {
    test('should return correct filetype for known languages', () => {
      expect(getSlackFiletype('javascript')).toBe('javascript');
      expect(getSlackFiletype('js')).toBe('javascript');
      expect(getSlackFiletype('python')).toBe('python');
      expect(getSlackFiletype('py')).toBe('python');
      expect(getSlackFiletype('HTML')).toBe('html'); // Case-insensitive
      expect(getSlackFiletype('Css')).toBe('css');
      expect(getSlackFiletype('yaml')).toBe('yaml');
      expect(getSlackFiletype('yml')).toBe('yaml');
    });

    test("should return 'text' for unknown languages", () => { // Use double quotes for description
      expect(getSlackFiletype('some_unknown_lang')).toBe('text');
      expect(getSlackFiletype('')).toBe('text');
      expect(getSlackFiletype(null)).toBe('text');
      expect(getSlackFiletype(undefined)).toBe('text');
    });
  });

  // --- Tests for splitMessageIntoChunks ---
  describe('splitMessageIntoChunks', () => {
    const MAX_LENGTH = 100; // Example max length for testing

    test('should not split message shorter than maxLength', () => {
      const message = 'This is a short message.';
      expect(splitMessageIntoChunks(message, MAX_LENGTH)).toEqual([message]);
    });

    test('should split long text message by character count', () => {
      const longText = 'a'.repeat(MAX_LENGTH + 50);
      const chunks = splitMessageIntoChunks(longText, MAX_LENGTH);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toMatch(/^\[1\/2\] /);
      expect(chunks[1]).toMatch(/^\[2\/2\] /);
      expect(chunks[0].length).toBeLessThanOrEqual(MAX_LENGTH + 6); // Account for [1/2] prefix
      expect(chunks[1].length).toBeLessThanOrEqual(MAX_LENGTH + 6);
    });

    test('should keep code blocks intact if they fit', () => {
      const message = 'Some text before.\n```js\n' + 'a'.repeat(50) + '\n```\nSome text after.';
      const chunks = splitMessageIntoChunks(message, MAX_LENGTH);
      expect(chunks.length).toBe(3); // Text, Code, Text
      expect(chunks[0]).toBe('[1/2] Some text before.');
      expect(chunks[1]).toMatch(/^```js\n/);
      expect(chunks[2]).toBe('[2/2] Some text after.');
    });

    test('should split text segments around an intact code block', () => {
       const message = 'a'.repeat(MAX_LENGTH - 10) + '\n```css\nbody { color: red; }\n```\n' + 'b'.repeat(MAX_LENGTH - 10);
       const chunks = splitMessageIntoChunks(message, MAX_LENGTH);
       expect(chunks.length).toBe(3);
       // The text part `a...` is 90 chars. Numbered [1/2] among non-code blocks.
       expect(chunks[0]).toBe('[1/2] ' + 'a'.repeat(90));
       expect(chunks[1]).toBe('```css\nbody { color: red; }\n```');
       // The text part `b...` is 90 chars. Numbered [2/2] among non-code blocks.
       expect(chunks[2]).toBe('[2/2] ' + 'b'.repeat(90));
    });

    test('should split a very large code block', () => {
      // Use MAX_SLACK_BLOCK_CODE_LENGTH from config if possible, otherwise estimate large value
      const CODE_MAX_LENGTH = 3000; // Assuming this is the relevant limit
      const largeCode = '```python\n' + 'p'.repeat(CODE_MAX_LENGTH + 100) + '\n```';
      // The split logic uses internal constants MAX_SLACK_BLOCK_CODE_LENGTH for code block splitting
      // The maxLength argument (100) here is for *text* segments.
      const chunks = splitMessageIntoChunks(largeCode, MAX_LENGTH);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0]).toMatch(/^```python\n/); // First chunk is the start of the code block
      // The actual code block splitting respects MAX_SLACK_BLOCK_CODE_LENGTH internally
      expect(chunks[0].length).toBeLessThanOrEqual(CODE_MAX_LENGTH); 
    });

     test('should handle message with only a code block longer than maxLength', () => {
        const codeBlock = '```\n' + 'c'.repeat(MAX_LENGTH + 20) + '\n```';
        // Even though the whole block is > MAX_LENGTH, the code block limit might be different
        // Let's assume MAX_SLACK_BLOCK_CODE_LENGTH > 120 for this test
        const chunks = splitMessageIntoChunks(codeBlock, MAX_LENGTH); // MAX_LENGTH = 100
        // Because the code block itself (126 chars) might fit within MAX_SLACK_BLOCK_CODE_LENGTH
        // but is larger than the general MAX_LENGTH, the behavior depends on internal constants.
        // Assuming it splits based on CODE_MAX_LENGTH, it might remain one chunk if CODE_MAX_LENGTH is large enough.
        // If CODE_MAX_LENGTH < 126, it would split. Let's test it stays as one block if it fits code limit.
        // For this test, let's assume MAX_SLACK_BLOCK_CODE_LENGTH is large (e.g. 3000), so it shouldn't split.
        // --> Revised expectation: If the code block fits *within the code block limit*, it should be one chunk. 
        // If MAX_SLACK_BLOCK_CODE_LENGTH was, say, 50, *then* it would split.
        
        // Let's test the case where it *should* split based on CODE_MAX_LENGTH
        const SHORT_CODE_MAX = 50;
        const longCodeBlock = '```\n' + 'd'.repeat(SHORT_CODE_MAX + 10) + '\n```'; // 66 chars
        // We need to mock MAX_SLACK_BLOCK_CODE_LENGTH or test against the actual value
        // For now, let's verify the splitting occurs if the block exceeds MAX_LENGTH (100)
        const chunks2 = splitMessageIntoChunks(longCodeBlock, MAX_LENGTH); // MaxLength=100
        // Since 66 < 100, it should NOT split based on the overall MAX_LENGTH
        expect(chunks2.length).toBe(1); 
        expect(chunks2[0]).toBe(longCodeBlock);

        // Test splitting based on overall MAX_LENGTH when code block limit is generous
        const codeBlockOverMaxLength = '```\n' + 'e'.repeat(MAX_LENGTH + 20) + '\n```'; // 126 chars
        const chunks3 = splitMessageIntoChunks(codeBlockOverMaxLength, MAX_LENGTH); // MaxLength=100
        // It *should* split because 126 > MAX_LENGTH (100), even if < CODE_MAX_LENGTH
        expect(chunks3.length).toBeGreaterThan(1);
        expect(chunks3[0].length).toBeLessThanOrEqual(MAX_LENGTH); // First chunk respects MAX_LENGTH
     });

    test('should return [""] for null or undefined message', () => {
        expect(splitMessageIntoChunks(null, MAX_LENGTH)).toEqual(['']);
        expect(splitMessageIntoChunks(undefined, MAX_LENGTH)).toEqual(['']);
    });
  });

  // Add describe blocks for other utils functions later
}); 