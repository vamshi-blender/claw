# Complete Tool Documentation

## 1. read_page

**Description:** Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones. Output is limited to 50000 characters. If the output exceeds this limit, you will receive an error asking you to specify a smaller depth or focus on a specific element using ref_id. Optionally filter for only interactive elements. If you don't have a valid tab ID, use tabs_context first to get available tabs.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tabId` | number | **Yes** | Tab ID to read from. Must be a tab in the current group. Use tabs_context first if you don't have a valid tab ID. |
| `depth` | number | No | Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large. |
| `filter` | string (enum) | No | Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements including non-visible ones (default: all elements). Options: `["interactive", "all"]` |
| `max_chars` | number | No | Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs. |
| `ref_id` | string | No | Reference ID of a parent element to read. Will return the specified element and all its children. Use this to focus on a specific part of the page when output is too large. |

---

## 2. find

**Description:** Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content (e.g., "organic mango product"). Returns up to 20 matching elements with references that can be used with other tools. If more than 20 matches exist, you'll be notified to use a more specific query. If you don't have a valid tab ID, use tabs_context first to get available tabs.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | **Yes** | Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic") |
| `tabId` | number | **Yes** | Tab ID to search in. Must be a tab in the current group. Use tabs_context first if you don't have a valid tab ID. |

---

## 3. form_input

**Description:** Set values in form elements using element reference ID from the read_page tool. If you don't have a valid tab ID, use tabs_context first to get available tabs.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ref` | string | **Yes** | Element reference ID from the read_page tool (e.g., "ref_1", "ref_2") |
| `value` | string, boolean, or number | **Yes** | The value to set. For checkboxes use boolean, for selects use option value or text, for other inputs use appropriate string/number |
| `tabId` | number | **Yes** | Tab ID to set form value in. Must be a tab in the current group. Use tabs_context first if you don't have a valid tab ID. |

---

## 4. computer

**Description:** Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don't have a valid tab ID, use tabs_context first to get available tabs.
* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.
* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.
* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string (enum) | **Yes** | The action to perform. Options: `["left_click", "right_click", "double_click", "triple_click", "type", "screenshot", "wait", "scroll", "key", "left_click_drag", "zoom", "scroll_to", "hover"]` |
| `tabId` | number | **Yes** | Tab ID to execute the action on. Must be a tab in the current group. Use tabs_context first if you don't have a valid tab ID. |
| `coordinate` | [x, y] | Conditional | Viewport coordinates (x pixels from left, y pixels from top). Required for `left_click`, `right_click`, `double_click`, `triple_click`, and `scroll`. For `left_click_drag`, this is the end position. |
| `duration` | number | Conditional | The number of seconds to wait. Required for `wait`. Maximum 30 seconds. |
| `modifiers` | string | No | Modifier keys for click actions. Supports: "ctrl", "shift", "alt", "cmd" (or "meta"), "win" (or "windows"). Can be combined with "+" (e.g., "ctrl+shift", "cmd+alt"). |
| `ref` | string | Conditional | Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Required for `scroll_to` action. Can be used as alternative to `coordinate` for click actions. |
| `region` | [x0, y0, x1, y1] | Conditional | The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom` action. |
| `repeat` | number | No | Number of times to repeat the key sequence (only for `key` action). Must be a positive integer between 1 and 100. Default is 1. |
| `scroll_amount` | number | No | The number of scroll wheel ticks. Optional for `scroll`, defaults to 3. |
| `scroll_direction` | string | Conditional | The direction to scroll. Required for `scroll`. Options: `["up", "down", "left", "right"]` |
| `start_coordinate` | [x, y] | Conditional | The starting coordinates for `left_click_drag`. |
| `text` | string | Conditional | The text to type (for `type` action) or the key(s) to press (for `key` action). For `key` action: Provide space-separated keys (e.g., "Backspace Backspace Delete"). Supports keyboard shortcuts using the platform's modifier key. |

---

## 5. navigate

**Description:** Navigate to a URL, or go forward/back in browser history. If you don't have a valid tab ID, use tabs_context first to get available tabs.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | **Yes** | The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history. |
| `tabId` | number | **Yes** | Tab ID to navigate. Must be a tab in the current group. Use tabs_context first if you don't have a valid tab ID. |

---

## 6. get_page_text

**Description:** Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting. If you don't have a valid tab ID, use tabs_context first to get available tabs. Output is limited to 50000 characters by default. If the output exceeds this limit, you will receive an error suggesting alternatives.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tabId` | number | **Yes** | Tab ID to extract text from. Must be a tab in the current group. Use tabs_context first if you don't have a valid tab ID. |
| `max_chars` | number | No | Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs. |

---

## 7. update_plan

**Description:** Update the plan and present it to the user for approval before proceeding.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `domains` | string[] | **Yes** | List of domains you will visit (e.g., ['github.com', 'stackoverflow.com']). These domains will be approved for the session when the user accepts the plan. |
| `approach` | string[] | **Yes** | Ordered list of steps you will follow (e.g., ['Navigate to homepage', 'Search for documentation', 'Extract key information']). Be concise - aim for 3-7 steps. |

---

## 8. tabs_create

**Description:** Creates a new empty tab in the current tab group

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | - | - | This tool takes no parameters. |

---

## 9. tabs_context

**Description:** Get context information about all tabs in the current tab group

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | - | - | This tool takes no parameters. |

---

## 10. upload_image

**Description:** Upload a previously captured screenshot or user-uploaded image to a file input or drag & drop target. Supports two approaches: (1) ref - for targeting specific elements, especially hidden file inputs, (2) coordinate - for drag & drop to visible locations like Google Docs. Provide either ref or coordinate, not both.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `imageId` | string | **Yes** | ID of a previously captured screenshot (from the computer tool's screenshot action) or a user-uploaded image |
| `tabId` | number | **Yes** | Tab ID where the target element is located. This is where the image will be uploaded to. |
| `ref` | string | Conditional | Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Use this for file inputs (especially hidden ones) or specific elements. Provide either ref or coordinate, not both. |
| `coordinate` | [x, y] | Conditional | Viewport coordinates [x, y] for drag & drop to a visible location. Use this for drag & drop targets like Google Docs. Provide either ref or coordinate, not both. |
| `filename` | string | No | Optional filename for the uploaded file (default: "image.png") |

---

## 11. file_upload

**Description:** Upload one or multiple files from the local filesystem to a file input element on the page. Do not click on file upload buttons or file inputs — clicking opens a native file picker dialog that you cannot see or interact with. Instead, use read_page or find to locate the file input element, then use this tool with its ref to upload files directly. The paths must be absolute file paths on the local machine.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paths` | string[] | **Yes** | The absolute paths to the files to upload. Can be a single file or multiple files. |
| `ref` | string | **Yes** | Element reference ID of the file input from read_page or find tools (e.g., "ref_1", "ref_2"). |
| `tabId` | number | **Yes** | Tab ID where the file input is located. Use tabs_context first if you don't have a valid tab ID. |

---

## 12. read_console_messages

**Description:** Read browser console messages (console.log, console.error, console.warn, etc.) from a specific tab. Useful for debugging JavaScript errors, viewing application logs, or understanding what's happening in the browser console. Returns console messages from the current domain only. If you don't have a valid tab ID, use tabs_context first to get available tabs. IMPORTANT: Always provide a pattern to filter messages - without a pattern, you may get too many irrelevant messages.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tabId` | number | **Yes** | Tab ID to read console messages from. Must be a tab in the current group. Use tabs_context first if you don't have a valid tab ID. |
| `pattern` | string | **Yes** | Regex pattern to filter console messages. Only messages matching this pattern will be returned (e.g., 'error\|warning' to find errors and warnings, 'MyApp' to filter app-specific logs). You should always provide a pattern to avoid getting too many irrelevant messages. |
| `clear` | boolean | No | If true, clear the console messages after reading to avoid duplicates on subsequent calls. Default is false. |
| `limit` | number | No | Maximum number of messages to return. Defaults to 100. Increase only if you need more results. |
| `onlyErrors` | boolean | No | If true, only return error and exception messages. Default is false (return all message types). |

---

## 13. read_network_requests

**Description:** Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. Useful for debugging API calls, monitoring network activity, or understanding what requests a page is making. Returns all network requests made by the current page, including cross-origin requests. Requests are automatically cleared when the page navigates to a different domain. If you don't have a valid tab ID, use tabs_context first to get available tabs.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tabId` | number | **Yes** | Tab ID to read network requests from. Must be a tab in the current group. Use tabs_context first if you don't have a valid tab ID. |
| `limit` | number | No | Maximum number of requests to return. Defaults to 100. Increase only if you need more results. |
| `clear` | boolean | No | If true, clear the network requests after reading to avoid duplicates on subsequent calls. Default is false. |
| `urlPattern` | string | No | Optional URL pattern to filter requests. Only requests whose URL contains this string will be returned (e.g., '/api/' to filter API calls, 'example.com' to filter by domain). |

---

## 14. resize_window

**Description:** Resize the current browser window to specified dimensions. Useful for testing responsive designs or setting up specific screen sizes. If you don't have a valid tab ID, use tabs_context first to get available tabs.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `width` | number | **Yes** | Target window width in pixels |
| `height` | number | **Yes** | Target window height in pixels |
| `tabId` | number | **Yes** | Tab ID to get the window for. Must be a tab in the current group. Use tabs_context first if you don't have a valid tab ID. |

---

## 15. gif_creator

**Description:** Manage GIF recording and export for browser automation sessions. Control when to start/stop recording browser actions (clicks, scrolls, navigation), then export as an animated GIF with visual overlays (click indicators, action labels, progress bar, watermark). All operations are scoped to the tab's group. When starting recording, take a screenshot immediately after to capture the initial state as the first frame. When stopping recording, take a screenshot immediately before to capture the final state as the last frame. For export, either provide 'coordinate' to drag/drop upload to a page element, or set 'download: true' to download the GIF.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string (enum) | **Yes** | Action to perform: 'start_recording' (begin capturing), 'stop_recording' (stop capturing but keep frames), 'export' (generate and export GIF), 'clear' (discard frames). Options: `["start_recording", "stop_recording", "export", "clear"]` |
| `tabId` | number | **Yes** | Tab ID to identify which tab group this operation applies to |
| `coordinate` | [x, y] | Conditional | Viewport coordinates [x, y] for drag & drop upload. Required for 'export' action unless 'download' is true. |
| `download` | boolean | No | If true, download the GIF instead of drag/drop upload. For 'export' action only. |
| `filename` | string | No | Optional filename for exported GIF (default: 'recording-[timestamp].gif'). For 'export' action only. |
| `options` | object | No | Optional GIF enhancement options for 'export' action. Properties: showClickIndicators (bool), showDragPaths (bool), showActionLabels (bool), showProgressBar (bool), showWatermark (bool), quality (number 1-30). All default to true except quality (default: 10). |

---

## 16. javascript_tool

**Description:** Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. If you don't have a valid tab ID, use tabs_context first to get available tabs.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | **Yes** | Must be set to 'javascript_exec' |
| `text` | string | **Yes** | The JavaScript code to execute. The code will be evaluated in the page context. The result of the last expression will be returned automatically. Do NOT use 'return' statements - just write the expression you want to evaluate (e.g., 'window.myData.value' not 'return window.myData.value'). You can access and modify the DOM, call page functions, and interact with page variables. |
| `tabId` | number | **Yes** | Tab ID to execute the code in. Must be a tab in the current group. Use tabs_context first if you don't have a valid tab ID. |

---

## 17. turn_answer_start

**Description:** Call this immediately before your text response to the user for this turn. Required every turn - whether or not you made tool calls. After calling, write your response. No more tools after this.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | - | - | This tool takes no parameters. |

---

# Complete Tool Usage Examples

## 1. read_page

**Example 1: Read entire page structure**
```json
{
  "tabId": 563774466
}
```

**Example 2: Read only interactive elements**
```json
{
  "tabId": 563774466,
  "filter": "interactive"
}
```

**Example 3: Read with limited depth**
```json
{
  "tabId": 563774466,
  "depth": 5,
  "filter": "interactive"
}
```

**Example 4: Read specific element and children**
```json
{
  "tabId": 563774466,
  "ref_id": "ref_12",
  "max_chars": 100000
}
```

---

## 2. find

**Example 1: Find a button by purpose**
```json
{
  "query": "submit button",
  "tabId": 563774466
}
```

**Example 2: Find a search bar**
```json
{
  "query": "search bar",
  "tabId": 563774466
}
```

**Example 3: Find product by text content**
```json
{
  "query": "product title containing organic mango",
  "tabId": 563774466
}
```

**Example 4: Find login input fields**
```json
{
  "query": "email input field",
  "tabId": 563774466
}
```

---

## 3. form_input

**Example 1: Fill text input**
```json
{
  "ref": "ref_5",
  "value": "John Doe",
  "tabId": 563774466
}
```

**Example 2: Set checkbox value**
```json
{
  "ref": "ref_8",
  "value": true,
  "tabId": 563774466
}
```

**Example 3: Select dropdown option by text**
```json
{
  "ref": "ref_12",
  "value": "United States",
  "tabId": 563774466
}
```

**Example 4: Set numeric value**
```json
{
  "ref": "ref_15",
  "value": 42,
  "tabId": 563774466
}
```

---

## 4. computer

### Screenshot
```json
{
  "action": "screenshot",
  "tabId": 563774466
}
```

### Left Click
```json
{
  "action": "left_click",
  "coordinate": [256, 120],
  "tabId": 563774466
}
```

### Left Click with Element Reference
```json
{
  "action": "left_click",
  "ref": "ref_5",
  "tabId": 563774466
}
```

### Right Click (Context Menu)
```json
{
  "action": "right_click",
  "coordinate": [500, 300],
  "tabId": 563774466
}
```

### Double Click
```json
{
  "action": "double_click",
  "coordinate": [400, 250],
  "tabId": 563774466
}
```

### Triple Click
```json
{
  "action": "triple_click",
  "coordinate": [300, 150],
  "tabId": 563774466
}
```

### Type Text
```json
{
  "action": "type",
  "text": "Hello World",
  "tabId": 563774466
}
```

### Type Multiple Characters
```json
{
  "action": "type",
  "text": "test@example.com",
  "tabId": 563774466
}
```

### Press Single Key
```json
{
  "action": "key",
  "text": "Enter",
  "tabId": 563774466
}
```

### Press Multiple Keys
```json
{
  "action": "key",
  "text": "Backspace Backspace Delete",
  "tabId": 563774466
}
```

### Press Keyboard Shortcut (Select All)
```json
{
  "action": "key",
  "text": "ctrl+a",
  "tabId": 563774466
}
```

### Press Keyboard Shortcut (Copy)
```json
{
  "action": "key",
  "text": "ctrl+c",
  "tabId": 563774466
}
```

### Press Keyboard Shortcut (Paste)
```json
{
  "action": "key",
  "text": "ctrl+v",
  "tabId": 563774466
}
```

### Press Key Multiple Times
```json
{
  "action": "key",
  "text": "ArrowDown",
  "repeat": 5,
  "tabId": 563774466
}
```

### Wait
```json
{
  "action": "wait",
  "duration": 2,
  "tabId": 563774466
}
```

### Scroll Down
```json
{
  "action": "scroll",
  "coordinate": [500, 300],
  "scroll_direction": "down",
  "scroll_amount": 5,
  "tabId": 563774466
}
```

### Scroll Up
```json
{
  "action": "scroll",
  "coordinate": [500, 300],
  "scroll_direction": "up",
  "scroll_amount": 3,
  "tabId": 563774466
}
```

### Scroll Left
```json
{
  "action": "scroll",
  "coordinate": [500, 300],
  "scroll_direction": "left",
  "scroll_amount": 2,
  "tabId": 563774466
}
```

### Scroll Right
```json
{
  "action": "scroll",
  "coordinate": [500, 300],
  "scroll_direction": "right",
  "scroll_amount": 2,
  "tabId": 563774466
}
```

### Drag and Drop
```json
{
  "action": "left_click_drag",
  "start_coordinate": [100, 100],
  "coordinate": [300, 300],
  "tabId": 563774466
}
```

### Scroll Element into View
```json
{
  "action": "scroll_to",
  "ref": "ref_20",
  "tabId": 563774466
}
```

### Zoom into Region
```json
{
  "action": "zoom",
  "region": [200, 150, 600, 400],
  "tabId": 563774466
}
```

### Hover over Element
```json
{
  "action": "hover",
  "coordinate": [250, 180],
  "tabId": 563774466
}
```

### Click with Modifier (Ctrl+Click)
```json
{
  "action": "left_click",
  "coordinate": [256, 120],
  "modifiers": "ctrl",
  "tabId": 563774466
}
```

### Click with Shift Modifier
```json
{
  "action": "left_click",
  "coordinate": [256, 120],
  "modifiers": "shift",
  "tabId": 563774466
}
```

### Click with Ctrl+Shift Modifier
```json
{
  "action": "left_click",
  "coordinate": [256, 120],
  "modifiers": "ctrl+shift",
  "tabId": 563774466
}
```

---

## 5. navigate

**Example 1: Navigate to URL**
```json
{
  "url": "https://example.com",
  "tabId": 563774466
}
```

**Example 2: Navigate without protocol**
```json
{
  "url": "google.com",
  "tabId": 563774466
}
```

**Example 3: Go back in history**
```json
{
  "url": "back",
  "tabId": 563774466
}
```

**Example 4: Go forward in history**
```json
{
  "url": "forward",
  "tabId": 563774466
}
```

---

## 6. get_page_text

**Example 1: Get all page text**
```json
{
  "tabId": 563774466
}
```

**Example 2: Get page text with higher limit**
```json
{
  "tabId": 563774466,
  "max_chars": 100000
}
```

---

## 7. update_plan

**Example 1: Update plan with domain and approach**
```json
{
  "domains": ["github.com", "stackoverflow.com"],
  "approach": [
    "Navigate to GitHub repository",
    "Search for documentation",
    "Extract key information",
    "Summarize findings"
  ]
}
```

**Example 2: Multi-domain plan**
```json
{
  "domains": ["google.com", "wikipedia.org", "github.com"],
  "approach": [
    "Search for information on Google",
    "Read Wikipedia article",
    "Check GitHub repository",
    "Compile results"
  ]
}
```

---

## 8. tabs_create

**Example 1: Create a new tab**
```json
{
  "action": "create"
}
```

(No parameters needed)

---

## 9. tabs_context

**Example 1: Get all tabs information**
```json
{}
```

(No parameters needed)

---

## 10. upload_image

**Example 1: Upload image using file input ref**
```json
{
  "imageId": "screenshot_001",
  "ref": "ref_10",
  "tabId": 563774466
}
```

**Example 2: Upload image with custom filename**
```json
{
  "imageId": "screenshot_001",
  "ref": "ref_10",
  "filename": "my-screenshot.png",
  "tabId": 563774466
}
```

**Example 3: Drag and drop upload**
```json
{
  "imageId": "screenshot_001",
  "coordinate": [500, 300],
  "tabId": 563774466
}
```

---

## 11. file_upload

**Example 1: Upload single file**
```json
{
  "paths": ["/home/user/documents/resume.pdf"],
  "ref": "ref_8",
  "tabId": 563774466
}
```

**Example 2: Upload multiple files**
```json
{
  "paths": [
    "/home/user/documents/file1.txt",
    "/home/user/documents/file2.txt",
    "/home/user/documents/file3.txt"
  ],
  "ref": "ref_8",
  "tabId": 563774466
}
```

**Example 3: Upload image file**
```json
{
  "paths": ["/home/user/pictures/photo.jpg"],
  "ref": "ref_12",
  "tabId": 563774466
}
```

---

## 12. read_console_messages

**Example 1: Read error messages**
```json
{
  "tabId": 563774466,
  "pattern": "error",
  "onlyErrors": true
}
```

**Example 2: Read specific app logs**
```json
{
  "tabId": 563774466,
  "pattern": "MyApp|React|Vue"
}
```

**Example 3: Read console messages and clear them**
```json
{
  "tabId": 563774466,
  "pattern": "warning|error",
  "clear": true,
  "limit": 50
}
```

**Example 4: Read all messages with limit**
```json
{
  "tabId": 563774466,
  "pattern": ".*",
  "limit": 200
}
```

---

## 13. read_network_requests

**Example 1: Read all network requests**
```json
{
  "tabId": 563774466
}
```

**Example 2: Filter API calls**
```json
{
  "tabId": 563774466,
  "urlPattern": "/api/"
}
```

**Example 3: Filter by domain**
```json
{
  "tabId": 563774466,
  "urlPattern": "example.com"
}
```

**Example 4: Read and clear requests**
```json
{
  "tabId": 563774466,
  "urlPattern": "/api/",
  "clear": true,
  "limit": 100
}
```

---

## 14. resize_window

**Example 1: Set standard desktop size**
```json
{
  "width": 1920,
  "height": 1080,
  "tabId": 563774466
}
```

**Example 2: Set tablet size**
```json
{
  "width": 768,
  "height": 1024,
  "tabId": 563774466
}
```

**Example 3: Set mobile size**
```json
{
  "width": 375,
  "height": 667,
  "tabId": 563774466
}
```

---

## 15. gif_creator

**Example 1: Start recording**
```json
{
  "action": "start_recording",
  "tabId": 563774466
}
```

**Example 2: Stop recording**
```json
{
  "action": "stop_recording",
  "tabId": 563774466
}
```

**Example 3: Export GIF with download**
```json
{
  "action": "export",
  "tabId": 563774466,
  "download": true,
  "filename": "my-recording.gif"
}
```

**Example 4: Export GIF with drag & drop**
```json
{
  "action": "export",
  "tabId": 563774466,
  "coordinate": [500, 300]
}
```

**Example 5: Export GIF with custom options**
```json
{
  "action": "export",
  "tabId": 563774466,
  "download": true,
  "filename": "demo.gif",
  "options": {
    "showClickIndicators": true,
    "showDragPaths": true,
    "showActionLabels": true,
    "showProgressBar": true,
    "showWatermark": false,
    "quality": 15
  }
}
```

**Example 6: Clear recorded frames**
```json
{
  "action": "clear",
  "tabId": 563774466
}
```

---

## 16. javascript_tool

**Example 1: Get page title**
```json
{
  "action": "javascript_exec",
  "text": "document.title",
  "tabId": 563774466
}
```

**Example 2: Get element text content**
```json
{
  "action": "javascript_exec",
  "text": "document.querySelector('h1').textContent",
  "tabId": 563774466
}
```

**Example 3: Modify DOM element**
```json
{
  "action": "javascript_exec",
  "text": "document.querySelector('button').style.display = 'none'",
  "tabId": 563774466
}
```

**Example 4: Get window object data**
```json
{
  "action": "javascript_exec",
  "text": "window.myData.value",
  "tabId": 563774466
}
```

**Example 5: Call page function**
```json
{
  "action": "javascript_exec",
  "text": "window.submitForm()",
  "tabId": 563774466
}
```

**Example 6: Get all form values**
```json
{
  "action": "javascript_exec",
  "text": "Array.from(document.querySelectorAll('input')).map(el => ({ name: el.name, value: el.value }))",
  "tabId": 563774466
}
```

**Example 7: Check if element exists**
```json
{
  "action": "javascript_exec",
  "text": "!!document.querySelector('.error-message')",
  "tabId": 563774466
}
```

**Example 8: Get all links on page**
```json
{
  "action": "javascript_exec",
  "text": "Array.from(document.querySelectorAll('a')).map(el => el.href)",
  "tabId": 563774466
}
```

---

## 17. turn_answer_start

**Example 1: Call before response**
```json
{}
```

(No parameters needed. Call immediately before writing your response to the user.)

---

# Tool Output Examples

## 1. read_page

**Description:** Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones.

**Example 1: Basic page structure**

**Input:**
```json
{
  "tabId": 563774466
}
```

**Output:**
```json
{
  "tree": [
    {
      "ref": "ref_1",
      "type": "document",
      "name": "Home Page",
      "children": [
        {
          "ref": "ref_2",
          "type": "banner",
          "name": "Header",
          "children": [
            {
              "ref": "ref_3",
              "type": "link",
              "name": "Home",
              "url": "/"
            },
            {
              "ref": "ref_4",
              "type": "link",
              "name": "About",
              "url": "/about"
            },
            {
              "ref": "ref_5",
              "type": "searchbox",
              "name": "Search products"
            }
          ]
        },
        {
          "ref": "ref_6",
          "type": "main",
          "name": "Main Content",
          "children": [
            {
              "ref": "ref_7",
              "type": "heading",
              "level": 1,
              "text": "Welcome to Our Store"
            },
            {
              "ref": "ref_8",
              "type": "article",
              "name": "Product Listing",
              "children": [
                {
                  "ref": "ref_9",
                  "type": "heading",
                  "level": 2,
                  "text": "Featured Products"
                }
              ]
            }
          ]
        },
        {
          "ref": "ref_10",
          "type": "contentinfo",
          "name": "Footer"
        }
      ]
    }
  ]
}
```

---

**Example 2: Interactive elements only**

**Input:**
```json
{
  "tabId": 563774466,
  "filter": "interactive"
}
```

**Output:**
```json
{
  "tree": [
    {
      "ref": "ref_1",
      "type": "button",
      "name": "Submit Order",
      "disabled": false
    },
    {
      "ref": "ref_2",
      "type": "link",
      "name": "View Details",
      "url": "/product/123"
    },
    {
      "ref": "ref_3",
      "type": "textbox",
      "name": "Email Address",
      "value": ""
    },
    {
      "ref": "ref_4",
      "type": "checkbox",
      "name": "I agree to terms",
      "checked": false
    },
    {
      "ref": "ref_5",
      "type": "combobox",
      "name": "Country",
      "options": ["United States", "Canada", "Mexico"]
    }
  ]
}
```

---

**Example 3: Limited depth structure**

**Input:**
```json
{
  "tabId": 563774466,
  "depth": 3
}
```

**Output:**
```json
{
  "tree": [
    {
      "ref": "ref_1",
      "type": "document",
      "children": [
        {
          "ref": "ref_2",
          "type": "banner",
          "children": [
            {
              "ref": "ref_3",
              "type": "link",
              "name": "Logo"
            }
          ]
        }
      ]
    }
  ]
}
```

---

**Example 4: Focused element reading with children**

**Input:**
```json
{
  "tabId": 563774466,
  "ref_id": "ref_12",
  "max_chars": 100000
}
```

**Output:**
```json
{
  "tree": [
    {
      "ref": "ref_12",
      "type": "section",
      "name": "Shopping Cart",
      "children": [
        {
          "ref": "ref_13",
          "type": "listitem",
          "name": "Product 1",
          "children": [
            {
              "ref": "ref_14",
              "type": "button",
              "name": "Remove Item"
            }
          ]
        },
        {
          "ref": "ref_15",
          "type": "listitem",
          "name": "Product 2"
        }
      ]
    }
  ]
}
```

---

**Use Cases:**

- **Page Navigation:** Understand the structure of a webpage before interacting with it
- **Element Reference:** Get ref IDs for use with other tools like form_input and computer
- **Interactive Elements:** Filter to find only clickable/interactive elements
- **Focused Inspection:** Read specific sections when page is large

---

## 2. find

**Description:** Find elements on the page using natural language. Returns up to 20 matching elements with references.

**Example 1: Find button by purpose**

**Input:**
```json
{
  "query": "submit button",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "results": [
    {
      "ref": "ref_23",
      "type": "button",
      "name": "Submit Order",
      "visible": true,
      "coordinates": [512, 450]
    },
    {
      "ref": "ref_24",
      "type": "button",
      "name": "Submit Form",
      "visible": true,
      "coordinates": [256, 320]
    }
  ],
  "count": 2
}
```

---

**Example 2: Find search bar**

**Input:**
```json
{
  "query": "search bar",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "results": [
    {
      "ref": "ref_8",
      "type": "searchbox",
      "name": "Search products",
      "placeholder": "Type to search...",
      "visible": true,
      "coordinates": [400, 100]
    }
  ],
  "count": 1
}
```

---

**Example 3: Find product by text content**

**Input:**
```json
{
  "query": "product title containing organic mango",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "results": [
    {
      "ref": "ref_45",
      "type": "article",
      "name": "Fresh Organic Mango - Best Quality",
      "text": "Fresh Organic Mango - Best Quality - $12.99",
      "visible": true,
      "coordinates": [300, 250]
    },
    {
      "ref": "ref_46",
      "type": "link",
      "name": "Organic Mango Smoothie Kit",
      "text": "Organic Mango Smoothie Kit - $24.99",
      "visible": true,
      "coordinates": [300, 350]
    }
  ],
  "count": 2
}
```

---

**Example 4: Find email input field**

**Input:**
```json
{
  "query": "email input field",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "results": [
    {
      "ref": "ref_67",
      "type": "textbox",
      "name": "Email Address",
      "inputType": "email",
      "visible": true,
      "coordinates": [400, 180]
    }
  ],
  "count": 1
}
```

---

**Use Cases:**

- **Element Discovery:** Find elements by their purpose or text content
- **Quick Targeting:** Get ref IDs without reading entire page structure
- **Multiple Matches:** See all matching elements when several exist

---

## 3. form_input

**Description:** Set values in form elements using element reference ID.

**Example 1: Fill text input**

**Input:**
```json
{
  "ref": "ref_5",
  "value": "John Doe",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "element": {
    "ref": "ref_5",
    "type": "textbox",
    "name": "Full Name",
    "previousValue": "",
    "newValue": "John Doe"
  }
}
```

---

**Example 2: Set checkbox value**

**Input:**
```json
{
  "ref": "ref_8",
  "value": true,
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "element": {
    "ref": "ref_8",
    "type": "checkbox",
    "name": "I agree to terms",
    "previousValue": false,
    "newValue": true
  }
}
```

---

**Example 3: Select dropdown option by text**

**Input:**
```json
{
  "ref": "ref_12",
  "value": "United States",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "element": {
    "ref": "ref_12",
    "type": "combobox",
    "name": "Country",
    "previousValue": "Canada",
    "newValue": "United States",
    "selectedIndex": 0
  }
}
```

---

**Example 4: Set numeric value**

**Input:**
```json
{
  "ref": "ref_15",
  "value": 42,
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "element": {
    "ref": "ref_15",
    "type": "spinbutton",
    "name": "Quantity",
    "previousValue": 1,
    "newValue": 42
  }
}
```

---

**Use Cases:**

- **Form Completion:** Fill in text fields with user information
- **Checkbox Management:** Toggle checkboxes for agreements or preferences
- **Dropdown Selection:** Choose options from select menus
- **Numeric Input:** Set quantity or numeric values in forms

---

## 4. computer

**Description:** Use mouse and keyboard to interact with web browser and take screenshots.

### Screenshot

**Input:**
```json
{
  "action": "screenshot",
  "tabId": 563774466
}
```

**Output:**
```
[PNG image of current browser viewport at 1920x1080 resolution showing the webpage]
```

---

### Left Click

**Input:**
```json
{
  "action": "left_click",
  "coordinate": [256, 120],
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "left_click",
  "coordinate": [256, 120],
  "clickedElement": {
    "ref": "ref_3",
    "type": "button",
    "name": "Submit"
  }
}
```

---

### Left Click with Element Reference

**Input:**
```json
{
  "action": "left_click",
  "ref": "ref_5",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "left_click",
  "ref": "ref_5",
  "clickedElement": {
    "type": "link",
    "name": "Next Page"
  }
}
```

---

### Right Click (Context Menu)

**Input:**
```json
{
  "action": "right_click",
  "coordinate": [500, 300],
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "right_click",
  "coordinate": [500, 300],
  "contextMenuOpened": true
}
```

---

### Double Click

**Input:**
```json
{
  "action": "double_click",
  "coordinate": [400, 250],
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "double_click",
  "coordinate": [400, 250],
  "textSelected": "example text content"
}
```

---

### Triple Click

**Input:**
```json
{
  "action": "triple_click",
  "coordinate": [300, 150],
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "triple_click",
  "coordinate": [300, 150],
  "fullLineSelected": true
}
```

---

### Type Text

**Input:**
```json
{
  "action": "type",
  "text": "Hello World",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "type",
  "textEntered": "Hello World",
  "currentFieldValue": "Hello World"
}
```

---

### Type Multiple Characters

**Input:**
```json
{
  "action": "type",
  "text": "test@example.com",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "type",
  "textEntered": "test@example.com",
  "currentFieldValue": "test@example.com",
  "validEmail": true
}
```

---

### Press Single Key

**Input:**
```json
{
  "action": "key",
  "text": "Enter",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "key",
  "keyPressed": "Enter",
  "formSubmitted": true
}
```

---

### Press Multiple Keys

**Input:**
```json
{
  "action": "key",
  "text": "Backspace Backspace Delete",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "key",
  "keysPressed": ["Backspace", "Backspace", "Delete"],
  "fieldCleared": true
}
```

---

### Press Keyboard Shortcut (Select All)

**Input:**
```json
{
  "action": "key",
  "text": "ctrl+a",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "key",
  "keySequence": "ctrl+a",
  "textSelected": true,
  "selectedLength": 145
}
```

---

### Press Keyboard Shortcut (Copy)

**Input:**
```json
{
  "action": "key",
  "text": "ctrl+c",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "key",
  "keySequence": "ctrl+c",
  "textCopied": true
}
```

---

### Press Keyboard Shortcut (Paste)

**Input:**
```json
{
  "action": "key",
  "text": "ctrl+v",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "key",
  "keySequence": "ctrl+v",
  "textPasted": true,
  "pastedContent": "Hello World"
}
```

---

### Press Key Multiple Times

**Input:**
```json
{
  "action": "key",
  "text": "ArrowDown",
  "repeat": 5,
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "key",
  "keyPressed": "ArrowDown",
  "repeatCount": 5,
  "currentSelection": "Option 5"
}
```

---

### Wait

**Input:**
```json
{
  "action": "wait",
  "duration": 2,
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "wait",
  "durationSeconds": 2,
  "completed": true
}
```

---

### Scroll Down

**Input:**
```json
{
  "action": "scroll",
  "coordinate": [500, 300],
  "scroll_direction": "down",
  "scroll_amount": 5,
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "scroll",
  "direction": "down",
  "scrollAmount": 5,
  "newScrollPosition": 450,
  "pageHeight": 2400
}
```

---

### Scroll Up

**Input:**
```json
{
  "action": "scroll",
  "coordinate": [500, 300],
  "scroll_direction": "up",
  "scroll_amount": 3,
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "scroll",
  "direction": "up",
  "scrollAmount": 3,
  "newScrollPosition": 150,
  "pageHeight": 2400
}
```

---

### Scroll Left

**Input:**
```json
{
  "action": "scroll",
  "coordinate": [500, 300],
  "scroll_direction": "left",
  "scroll_amount": 2,
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "scroll",
  "direction": "left",
  "scrollAmount": 2,
  "newHorizontalPosition": 100
}
```

---

### Scroll Right

**Input:**
```json
{
  "action": "scroll",
  "coordinate": [500, 300],
  "scroll_direction": "right",
  "scroll_amount": 2,
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "scroll",
  "direction": "right",
  "scrollAmount": 2,
  "newHorizontalPosition": 300
}
```

---

### Drag and Drop

**Input:**
```json
{
  "action": "left_click_drag",
  "start_coordinate": [100, 100],
  "coordinate": [300, 300],
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "left_click_drag",
  "startCoordinate": [100, 100],
  "endCoordinate": [300, 300],
  "distanceMoved": 283,
  "dropCompleted": true
}
```

---

### Scroll Element into View

**Input:**
```json
{
  "action": "scroll_to",
  "ref": "ref_20",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "scroll_to",
  "ref": "ref_20",
  "elementScrolledIntoView": true,
  "newPosition": [500, 400]
}
```

---

### Zoom into Region

**Input:**
```json
{
  "action": "zoom",
  "region": [200, 150, 600, 400],
  "tabId": 563774466
}
```

**Output:**
```
[PNG zoomed screenshot of region from (200, 150) to (600, 400)]
```

---

### Hover over Element

**Input:**
```json
{
  "action": "hover",
  "coordinate": [250, 180],
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "hover",
  "coordinate": [250, 180],
  "hoverElement": {
    "ref": "ref_12",
    "type": "button",
    "name": "Settings"
  },
  "tooltipShown": true,
  "tooltipText": "Click to open settings"
}
```

---

### Click with Modifier (Ctrl+Click)

**Input:**
```json
{
  "action": "left_click",
  "coordinate": [256, 120],
  "modifiers": "ctrl",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "left_click",
  "coordinate": [256, 120],
  "modifiers": "ctrl",
  "newTabOpened": true
}
```

---

### Click with Shift Modifier

**Input:**
```json
{
  "action": "left_click",
  "coordinate": [256, 120],
  "modifiers": "shift",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "left_click",
  "coordinate": [256, 120],
  "modifiers": "shift",
  "selectionExtended": true,
  "selectedItems": 5
}
```

---

### Click with Ctrl+Shift Modifier

**Input:**
```json
{
  "action": "left_click",
  "coordinate": [256, 120],
  "modifiers": "ctrl+shift",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "left_click",
  "coordinate": [256, 120],
  "modifiers": "ctrl+shift",
  "specialAction": true
}
```

---

**Use Cases:**

- **Screenshots:** Capture visual state of webpage at any time
- **Navigation:** Click buttons, links, and interactive elements
- **Text Input:** Type text into forms and search boxes
- **Keyboard Shortcuts:** Execute standard browser and application shortcuts
- **Scrolling:** Navigate long pages vertically or horizontally
- **Drag & Drop:** Move elements around the page
- **Hover Actions:** Reveal tooltips and trigger hover states

---

## 5. navigate

**Description:** Navigate to a URL, or go forward/back in browser history.

**Example 1: Navigate to URL**

**Input:**
```json
{
  "url": "https://example.com",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "navigate",
  "url": "https://example.com",
  "previousUrl": "https://google.com",
  "pageLoadTime": 1250,
  "statusCode": 200
}
```

---

**Example 2: Navigate without protocol**

**Input:**
```json
{
  "url": "google.com",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "navigate",
  "requestedUrl": "google.com",
  "resolvedUrl": "https://google.com",
  "pageLoadTime": 890,
  "statusCode": 200
}
```

---

**Example 3: Go back in history**

**Input:**
```json
{
  "url": "back",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "navigate",
  "direction": "back",
  "previousPage": "https://example.com/page2",
  "currentPage": "https://example.com/page1",
  "pageLoadTime": 450
}
```

---

**Example 4: Go forward in history**

**Input:**
```json
{
  "url": "forward",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "navigate",
  "direction": "forward",
  "previousPage": "https://example.com/page1",
  "currentPage": "https://example.com/page2",
  "pageLoadTime": 520
}
```

---

**Use Cases:**

- **Direct Navigation:** Go to specific websites
- **Browser History:** Navigate back and forward through visited pages
- **Protocol Handling:** Automatically add https:// to URLs without protocol

---

## 6. get_page_text

**Description:** Extract raw text content from the page. Returns plain text without HTML formatting.

**Example 1: Get all page text**

**Input:**
```json
{
  "tabId": 563774466
}
```

**Output:**
```
Home | About | Contact

Welcome to Our Store

Discover the finest selection of organic products delivered straight to your door.

Featured Products

Fresh Organic Mango - $12.99
Premium quality mangoes sourced from local farms. Rich in vitamins and minerals.

Organic Spinach Bundle - $8.49
Freshly picked spinach packed with nutrients. Perfect for salads and smoothies.

Customer Reviews

"Great quality and fast delivery!" - Sarah M.
"Best organic products I've found online" - John D.

Footer | Privacy Policy | Terms of Service
```

---

**Example 2: Get page text with higher character limit**

**Input:**
```json
{
  "tabId": 563774466,
  "max_chars": 100000
}
```

**Output:**
```
[Extended text content up to 100,000 characters from the page, including all visible and prioritized article content]
```

---

**Use Cases:**

- **Article Reading:** Extract article text for analysis
- **Content Analysis:** Get plain text for text processing tasks
- **Information Extraction:** Pull all readable text from a page
- **Large Content:** Handle pages with extended character limits

---

## 7. update_plan

**Description:** Update the plan and present it to the user for approval before proceeding.

**Example 1: Update plan with single domain**

**Input:**
```json
{
  "domains": ["github.com"],
  "approach": [
    "Navigate to GitHub repository",
    "Search for documentation",
    "Extract key information"
  ]
}
```

**Output:**
```json
{
  "success": true,
  "planUpdated": true,
  "message": "Plan updated and presented to user for approval",
  "domains": ["github.com"],
  "approach": [
    "Navigate to GitHub repository",
    "Search for documentation",
    "Extract key information"
  ],
  "awaitingUserApproval": true
}
```

---

**Example 2: Multi-domain plan**

**Input:**
```json
{
  "domains": ["google.com", "wikipedia.org", "github.com"],
  "approach": [
    "Search for information on Google",
    "Read Wikipedia article",
    "Check GitHub repository",
    "Compile results"
  ]
}
```

**Output:**
```json
{
  "success": true,
  "planUpdated": true,
  "message": "Multi-domain plan updated",
  "domains": ["google.com", "wikipedia.org", "github.com"],
  "approach": [
    "Search for information on Google",
    "Read Wikipedia article",
    "Check GitHub repository",
    "Compile results"
  ],
  "awaitingUserApproval": true,
  "approvalPromptSentToUser": true
}
```

---

**Use Cases:**

- **Plan Transparency:** Show user the plan before execution
- **Domain Approval:** Get approval for domains to be visited
- **Step Documentation:** Present ordered approach for user confirmation
- **Task Authorization:** Ensure user agrees with planned actions

---

## 8. tabs_create

**Description:** Creates a new empty tab in the current tab group

**Example 1: Create a new tab**

**Input:**
```json
{}
```

**Output:**
```json
{
  "success": true,
  "newTabId": 563774467,
  "newTabUrl": "chrome://newtab",
  "newTabTitle": "New Tab",
  "totalTabsInGroup": 2
}
```

---

**Example 2: Create new tab when multiple tabs exist**

**Input:**
```json
{}
```

**Output:**
```json
{
  "success": true,
  "newTabId": 563774470,
  "newTabUrl": "chrome://newtab",
  "newTabTitle": "New Tab",
  "totalTabsInGroup": 5,
  "tabGroupId": "group_001"
}
```

---

**Use Cases:**

- **Parallel Work:** Open a new tab for different task
- **Context Separation:** Keep different workflows in separate tabs
- **Multi-step Tasks:** Open supporting tabs while maintaining main task

---

## 9. tabs_context

**Description:** Get context information about all tabs in the current tab group

**Example 1: Basic tabs context (no active editing)**

**Input:**
```json
{}
```

**Output:**
```json
{
  "availableTabs": [
    {
      "tabId": 563776948,
      "title": "Google Search",
      "url": "https://google.com"
    },
    {
      "tabId": 563776949,
      "title": "GitHub - User Profile",
      "url": "https://github.com/username"
    }
  ],
  "initialTabId": 563776948
}
```

---

**Example 2: Multiple tabs with domain skills**

**Input:**
```json
{}
```

**Output:**
```json
{
  "availableTabs": [
    {
      "tabId": 563774466,
      "title": "Amazon Shopping Cart",
      "url": "https://www.amazon.com/cart"
    },
    {
      "tabId": 563774467,
      "title": "Gmail Inbox",
      "url": "https://mail.google.com/mail"
    },
    {
      "tabId": 563774468,
      "title": "Documentation - API Reference",
      "url": "https://docs.example.com/api"
    }
  ],
  "initialTabId": 563774466,
  "domainSkills": [
    {
      "domain": "amazon.com",
      "skill": "Use 'Add to Cart' buttons and 'Proceed to Checkout' workflow"
    },
    {
      "domain": "mail.google.com",
      "skill": "Gmail interface: compose with keyboard shortcut 'c', archive with 'e', search using filter syntax"
    },
    {
      "domain": "docs.example.com",
      "skill": "Search documentation with the search box in the header, use left sidebar for navigation"
    }
  ]
}
```

---

**Example 3: Single tab with initialTabId reference**

**Input:**
```json
{}
```

**Output:**
```json
{
  "availableTabs": [
    {
      "tabId": 563776948,
      "title": "Online Markdown Editor - Dillinger",
      "url": "https://dillinger.io/"
    }
  ],
  "initialTabId": 563776948
}
```

---

**Example 4: Tabs context showing newly created tab**

**Input:**
```json
{}
```

**Output:**
```json
{
  "availableTabs": [
    {
      "tabId": 563774466,
      "title": "Example Domain",
      "url": "https://example.com"
    },
    {
      "tabId": 563774467,
      "title": "New Tab",
      "url": "chrome://newtab"
    }
  ],
  "initialTabId": 563774466,
  "domainSkills": [
    {
      "domain": "example.com",
      "skill": "Static example page with basic HTML structure"
    }
  ]
}
```

---

**Use Cases:**

- **Tab Validation:** Check if you have a valid tab ID before using other tools
- **Tab Selection:** Identify which tab to use when multiple tabs are available
- **Domain Information:** Get domain-specific guidance for interacting with different websites
- **Tab Creation Verification:** Confirm that a new tab was successfully created
- **Multi-Tab Workflows:** Determine which tab is the user's active tab (initialTabId)

---

## 10. upload_image

**Description:** Upload a previously captured screenshot or user-uploaded image to a file input or drag & drop target.

**Example 1: Upload image using file input ref**

**Input:**
```json
{
  "imageId": "screenshot_001",
  "ref": "ref_10",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "upload_image",
  "imageId": "screenshot_001",
  "targetElement": {
    "ref": "ref_10",
    "type": "input",
    "inputType": "file"
  },
  "uploadedFile": {
    "name": "image.png",
    "size": 24576,
    "mimeType": "image/png"
  }
}
```

---

**Example 2: Upload image with custom filename**

**Input:**
```json
{
  "imageId": "screenshot_001",
  "ref": "ref_10",
  "filename": "my-screenshot.png",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "upload_image",
  "imageId": "screenshot_001",
  "targetElement": {
    "ref": "ref_10",
    "type": "input",
    "inputType": "file"
  },
  "uploadedFile": {
    "name": "my-screenshot.png",
    "size": 24576,
    "mimeType": "image/png"
  }
}
```

---

**Example 3: Drag and drop upload**

**Input:**
```json
{
  "imageId": "screenshot_001",
  "coordinate": [500, 300],
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "upload_image",
  "method": "drag_and_drop",
  "imageId": "screenshot_001",
  "dropTarget": {
    "coordinate": [500, 300],
    "element": "document area"
  },
  "uploadedFile": {
    "name": "image.png",
    "size": 24576,
    "mimeType": "image/png"
  }
}
```

---

**Use Cases:**

- **File Upload:** Upload screenshots to file input elements
- **Drag & Drop:** Upload images to drag-and-drop zones
- **Document Attachment:** Add images to documents or forms
- **Custom Naming:** Upload with specific filename

---

## 11. file_upload

**Description:** Upload files from local filesystem to a file input element on the page.

**Example 1: Upload single file**

**Input:**
```json
{
  "paths": ["/home/user/documents/resume.pdf"],
  "ref": "ref_8",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "file_upload",
  "filesUploaded": [
    {
      "path": "/home/user/documents/resume.pdf",
      "filename": "resume.pdf",
      "size": 245760,
      "mimeType": "application/pdf"
    }
  ],
  "targetElement": {
    "ref": "ref_8",
    "type": "input",
    "inputType": "file"
  },
  "uploadCompleted": true
}
```

---

**Example 2: Upload multiple files**

**Input:**
```json
{
  "paths": [
    "/home/user/documents/file1.txt",
    "/home/user/documents/file2.txt",
    "/home/user/documents/file3.txt"
  ],
  "ref": "ref_8",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "file_upload",
  "filesUploaded": [
    {
      "path": "/home/user/documents/file1.txt",
      "filename": "file1.txt",
      "size": 12345
    },
    {
      "path": "/home/user/documents/file2.txt",
      "filename": "file2.txt",
      "size": 23456
    },
    {
      "path": "/home/user/documents/file3.txt",
      "filename": "file3.txt",
      "size": 34567
    }
  ],
  "targetElement": {
    "ref": "ref_8",
    "type": "input",
    "inputType": "file",
    "multiple": true
  },
  "uploadCompleted": true,
  "totalFilesUploaded": 3
}
```

---

**Example 3: Upload image file**

**Input:**
```json
{
  "paths": ["/home/user/pictures/photo.jpg"],
  "ref": "ref_12",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "file_upload",
  "filesUploaded": [
    {
      "path": "/home/user/pictures/photo.jpg",
      "filename": "photo.jpg",
      "size": 512000,
      "mimeType": "image/jpeg",
      "dimensions": "1920x1080"
    }
  ],
  "targetElement": {
    "ref": "ref_12",
    "type": "input",
    "inputType": "file",
    "accept": "image/*"
  },
  "uploadCompleted": true
}
```

---

**Use Cases:**

- **Document Upload:** Upload PDFs, Word docs to forms
- **Batch Upload:** Upload multiple files at once
- **Image Upload:** Upload photos or graphics
- **File Attachment:** Add files to emails, messages, or forms

---

## 12. read_console_messages

**Description:** Read browser console messages including logs, errors, and warnings.

**Example 1: Read error messages**

**Input:**
```json
{
  "tabId": 563774466,
  "pattern": "error",
  "onlyErrors": true
}
```

**Output:**
```json
{
  "success": true,
  "messagesCount": 3,
  "messages": [
    {
      "type": "error",
      "message": "TypeError: Cannot read property 'map' of undefined",
      "timestamp": "2024-02-24T11:47:59.123Z",
      "source": "script.js:45"
    },
    {
      "type": "error",
      "message": "404 Not Found: /api/products",
      "timestamp": "2024-02-24T11:48:01.456Z",
      "source": "app.js:120"
    },
    {
      "type": "error",
      "message": "Network request failed",
      "timestamp": "2024-02-24T11:48:02.789Z",
      "source": "network.js:89"
    }
  ]
}
```

**Example 2: Read specific app logs**

**Input:**
```json
{
  "tabId": 563774466,
  "pattern": "MyApp|React|Vue"
}
```

**Output:**
```json
{
  "success": true,
  "messagesCount": 5,
  "messages": [
    {
      "type": "log",
      "message": "MyApp initialized successfully",
      "timestamp": "2024-02-24T11:45:10.123Z",
      "source": "app.js:15"
    },
    {
      "type": "log",
      "message": "React component mounted: ProductList",
      "timestamp": "2024-02-24T11:45:11.456Z",
      "source": "ProductList.jsx:42"
    },
    {
      "type": "warning",
      "message": "React warning: setState deprecated in strict mode",
      "timestamp": "2024-02-24T11:45:12.789Z",
      "source": "utils.js:67"
    },
    {
      "type": "log",
      "message": "MyApp data fetched: 24 products",
      "timestamp": "2024-02-24T11:45:13.012Z",
      "source": "api.js:88"
    },
    {
      "type": "log",
      "message": "Vue instance created",
      "timestamp": "2024-02-24T11:45:14.345Z",
      "source": "main.js:5"
    }
  ]
}
```

---

**Example 3: Read console messages and clear them**

**Input:**
```json
{
  "tabId": 563774466,
  "pattern": "warning|error",
  "clear": true,
  "limit": 50
}
```

**Output:**
```json
{
  "success": true,
  "messagesCount": 8,
  "messagesCleared": true,
  "messages": [
    {
      "type": "warning",
      "message": "Deprecation warning: Old API will be removed in v3.0",
      "timestamp": "2024-02-24T11:46:20.123Z"
    },
    {
      "type": "error",
      "message": "Failed to load image: /images/missing.jpg",
      "timestamp": "2024-02-24T11:46:21.456Z"
    },
    {
      "type": "warning",
      "message": "Performance: Long task detected (2500ms)",
      "timestamp": "2024-02-24T11:46:22.789Z"
    },
    {
      "type": "error",
      "message": "CORS error: Access-Control-Allow-Origin missing",
      "timestamp": "2024-02-24T11:46:23.012Z"
    },
    {
      "type": "warning",
      "message": "localStorage quota exceeded",
      "timestamp": "2024-02-24T11:46:24.345Z"
    },
    {
      "type": "error",
      "message": "Undefined variable: config",
      "timestamp": "2024-02-24T11:46:25.678Z"
    },
    {
      "type": "warning",
      "message": "Unused CSS selector: .old-class",
      "timestamp": "2024-02-24T11:46:26.901Z"
    },
    {
      "type": "error",
      "message": "Promise rejection: API timeout",
      "timestamp": "2024-02-24T11:46:27.234Z"
    }
  ]
}
```

---

**Example 4: Read all messages with limit**

**Input:**
```json
{
  "tabId": 563774466,
  "pattern": ".*",
  "limit": 200
}
```

**Output:**
```json
{
  "success": true,
  "messagesCount": 45,
  "limitApplied": 200,
  "messages": [
    {
      "type": "log",
      "message": "Page loaded",
      "timestamp": "2024-02-24T11:40:00.000Z"
    },
    {
      "type": "log",
      "message": "Connecting to WebSocket server",
      "timestamp": "2024-02-24T11:40:01.123Z"
    },
    {
      "type": "log",
      "message": "WebSocket connected",
      "timestamp": "2024-02-24T11:40:02.456Z"
    },
    {
      "type": "info",
      "message": "User session started",
      "timestamp": "2024-02-24T11:40:03.789Z"
    },
    {
      "type": "log",
      "message": "Fetching user preferences",
      "timestamp": "2024-02-24T11:40:04.012Z"
    }
  ]
}
```

---

**Use Cases:**

- **Debug Errors:** Find JavaScript errors preventing functionality
- **Monitor Logs:** Track application execution flow
- **Identify Warnings:** Spot deprecation warnings and performance issues
- **Clear Messages:** Reset console for fresh session
- **Troubleshooting:** Diagnose page issues

---

## 13. read_network_requests

**Description:** Read HTTP network requests from a specific tab.

**Example 1: Read all network requests**

**Input:**
```json
{
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "requestsCount": 12,
  "requests": [
    {
      "url": "https://example.com/",
      "method": "GET",
      "resourceType": "document",
      "statusCode": 200,
      "responseTime": 450,
      "size": 125000,
      "timestamp": "2024-02-24T11:40:00.000Z"
    },
    {
      "url": "https://example.com/styles.css",
      "method": "GET",
      "resourceType": "stylesheet",
      "statusCode": 200,
      "responseTime": 120,
      "size": 45000,
      "timestamp": "2024-02-24T11:40:01.100Z"
    },
    {
      "url": "https://example.com/app.js",
      "method": "GET",
      "resourceType": "script",
      "statusCode": 200,
      "responseTime": 200,
      "size": 85000,
      "timestamp": "2024-02-24T11:40:01.300Z"
    },
    {
      "url": "https://api.example.com/users",
      "method": "GET",
      "resourceType": "xhr",
      "statusCode": 200,
      "responseTime": 250,
      "size": 12000,
      "timestamp": "2024-02-24T11:40:02.000Z"
    },
    {
      "url": "https://api.example.com/products",
      "method": "GET",
      "resourceType": "fetch",
      "statusCode": 200,
      "responseTime": 350,
      "size": 52000,
      "timestamp": "2024-02-24T11:40:02.500Z"
    }
  ]
}
```

---

**Example 2: Filter API calls**

**Input:**
```json
{
  "tabId": 563774466,
  "urlPattern": "/api/"
}
```

**Output:**
```json
{
  "success": true,
  "requestsCount": 8,
  "pattern": "/api/",
  "requests": [
    {
      "url": "https://api.example.com/users",
      "method": "GET",
      "statusCode": 200,
      "responseTime": 250,
      "size": 12000
    },
    {
      "url": "https://api.example.com/products",
      "method": "GET",
      "statusCode": 200,
      "responseTime": 350,
      "size": 52000
    },
    {
      "url": "https://api.example.com/orders",
      "method": "POST",
      "statusCode": 201,
      "responseTime": 450,
      "size": 8000,
      "requestBody": "{ order data }"
    },
    {
      "url": "https://api.example.com/checkout",
      "method": "POST",
      "statusCode": 200,
      "responseTime": 520,
      "size": 15000
    },
    {
      "url": "https://api.example.com/users/123",
      "method": "PUT",
      "statusCode": 200,
      "responseTime": 180,
      "size": 5000
    },
    {
      "url": "https://api.example.com/auth/token",
      "method": "POST",
      "statusCode": 200,
      "responseTime": 300,
      "size": 2000
    },
    {
      "url": "https://api.example.com/notifications",
      "method": "GET",
      "statusCode": 200,
      "responseTime": 200,
      "size": 8000
    },
    {
      "url": "https://api.example.com/settings",
      "method": "GET",
      "statusCode": 200,
      "responseTime": 100,
      "size": 3000
    }
  ]
}
```

---

**Example 3: Filter by domain**

**Input:**
```json
{
  "tabId": 563774466,
  "urlPattern": "example.com"
}
```

**Output:**
```json
{
  "success": true,
  "requestsCount": 10,
  "pattern": "example.com",
  "requests": [
    {
      "url": "https://example.com/",
      "method": "GET",
      "statusCode": 200,
      "responseTime": 450
    },
    {
      "url": "https://api.example.com/data",
      "method": "GET",
      "statusCode": 200,
      "responseTime": 250
    },
    {
      "url": "https://cdn.example.com/image.jpg",
      "method": "GET",
      "statusCode": 200,
      "responseTime": 150
    },
    {
      "url": "https://analytics.example.com/track",
      "method": "POST",
      "statusCode": 204,
      "responseTime": 50
    }
  ]
}
```

---

**Example 4: Read and clear requests**

**Input:**
```json
{
  "tabId": 563774466,
  "urlPattern": "/api/",
  "clear": true,
  "limit": 100
}
```

**Output:**
```json
{
  "success": true,
  "requestsCount": 6,
  "requestsCleared": true,
  "requests": [
    {
      "url": "https://api.example.com/users",
      "method": "GET",
      "statusCode": 200,
      "responseTime": 250
    },
    {
      "url": "https://api.example.com/products",
      "method": "GET",
      "statusCode": 200,
      "responseTime": 350
    },
    {
      "url": "https://api.example.com/orders",
      "method": "POST",
      "statusCode": 201,
      "responseTime": 450
    },
    {
      "url": "https://api.example.com/checkout",
      "method": "POST",
      "statusCode": 200,
      "responseTime": 520
    },
    {
      "url": "https://api.example.com/notifications",
      "method": "GET",
      "statusCode": 200,
      "responseTime": 200
    },
    {
      "url": "https://api.example.com/error-log",
      "method": "POST",
      "statusCode": 500,
      "responseTime": 1500,
      "error": "Server error"
    }
  ]
}
```

---

**Use Cases:**

- **API Debugging:** Monitor API calls and responses
- **Performance Analysis:** Check response times and payload sizes
- **Error Tracking:** Identify failed requests (4xx, 5xx status codes)
- **Network Filtering:** Focus on specific domains or endpoints
- **Request Inspection:** View request methods, headers, and response data

---

## 14. resize_window

**Description:** Resize the current browser window to specified dimensions.

**Example 1: Set standard desktop size**

**Input:**
```json
{
  "width": 1920,
  "height": 1080,
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "resize_window",
  "previousDimensions": {
    "width": 1366,
    "height": 768
  },
  "newDimensions": {
    "width": 1920,
    "height": 1080
  },
  "deviceType": "desktop"
}
```

---

**Example 2: Set tablet size**

**Input:**
```json
{
  "width": 768,
  "height": 1024,
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "resize_window",
  "previousDimensions": {
    "width": 1920,
    "height": 1080
  },
  "newDimensions": {
    "width": 768,
    "height": 1024
  },
  "deviceType": "tablet",
  "orientation": "portrait"
}
```

---

**Example 3: Set mobile size**

**Input:**
```json
{
  "width": 375,
  "height": 667,
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "resize_window",
  "previousDimensions": {
    "width": 768,
    "height": 1024
  },
  "newDimensions": {
    "width": 375,
    "height": 667
  },
  "deviceType": "mobile",
  "orientation": "portrait"
}
```

---

**Use Cases:**

- **Responsive Testing:** Test how pages look at different screen sizes
- **Device Emulation:** Simulate desktop, tablet, and mobile viewports
- **Breakpoint Testing:** Check CSS media query breakpoints
- **Screenshot Comparison:** Capture layouts at different resolutions

---

## 15. gif_creator

**Description:** Manage GIF recording and export for browser automation sessions.

**Example 1: Start recording**

**Input:**
```json
{
  "action": "start_recording",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "start_recording",
  "recordingStarted": true,
  "timestamp": "2024-02-24T11:50:00.000Z",
  "framesCount": 1
}
```

---

**Example 2: Stop recording**

**Input:**
```json
{
  "action": "stop_recording",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "stop_recording",
  "recordingStopped": true,
  "framesCount": 45,
  "recordingDuration": 15,
  "timestamp": "2024-02-24T11:50:15.000Z"
}
```

---

**Example 3: Export GIF with download**

**Input:**
```json
{
  "action": "export",
  "tabId": 563774466,
  "download": true,
  "filename": "my-recording.gif"
}
```

**Output:**
```json
{
  "success": true,
  "action": "export",
  "gifCreated": true,
  "filename": "my-recording.gif",
  "fileSize": 2048000,
  "framesProcessed": 45,
  "downloadStarted": true,
  "downloadPath": "/downloads/my-recording.gif"
}
```

---

**Example 4: Export GIF with drag & drop**

**Input:**
```json
{
  "action": "export",
  "tabId": 563774466,
  "coordinate": [500, 300]
}
```

**Output:**
```json
{
  "success": true,
  "action": "export",
  "gifCreated": true,
  "framesProcessed": 45,
  "dragDropTarget": {
    "coordinate": [500, 300],
    "element": "document"
  },
  "uploadReady": true
}
```

---

**Example 5: Export GIF with custom options**

**Input:**
```json
{
  "action": "export",
  "tabId": 563774466,
  "download": true,
  "filename": "demo.gif",
  "options": {
    "showClickIndicators": true,
    "showDragPaths": true,
    "showActionLabels": true,
    "showProgressBar": true,
    "showWatermark": false,
    "quality": 15
  }
}
```

**Output:**
```json
{
  "success": true,
  "action": "export",
  "gifCreated": true,
  "filename": "demo.gif",
  "fileSize": 3072000,
  "framesProcessed": 45,
  "options": {
    "clickIndicators": "enabled",
    "dragPaths": "enabled",
    "actionLabels": "enabled",
    "progressBar": "enabled",
    "watermark": "disabled",
    "qualityLevel": 15
  },
  "downloadStarted": true
}
```

---

**Example 6: Clear recorded frames**

**Input:**
```json
{
  "action": "clear",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "clear",
  "framesClearedCount": 45,
  "recordingCleared": true
}
```

---

**Use Cases:**

- **Screen Recording:** Record browser automation sequences
- **Tutorial Creation:** Create step-by-step visual guides
- **Demonstration:** Show how to use features with visual overlay
- **Documentation:** Generate animated examples of workflows
- **Presentation:** Create engaging visual content for demos

---

## 16. javascript_tool

**Description:** Execute JavaScript code in the context of the current page.

**Example 1: Get page title**

**Input:**
```json
{
  "action": "javascript_exec",
  "text": "document.title",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "javascript_exec",
  "code": "document.title",
  "result": "Welcome to My Website - Example Domain"
}
```

---

**Example 2: Get element text content**

**Input:**
```json
{
  "action": "javascript_exec",
  "text": "document.querySelector('h1').textContent",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "javascript_exec",
  "code": "document.querySelector('h1').textContent",
  "result": "Welcome to Our Store"
}
```

---

**Example 3: Modify DOM element**

**Input:**
```json
{
  "action": "javascript_exec",
  "text": "document.querySelector('button').style.display = 'none'",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "javascript_exec",
  "code": "document.querySelector('button').style.display = 'none'",
  "result": "none",
  "elementModified": true
}
```

---

**Example 4: Get window object data**

**Input:**
```json
{
  "action": "javascript_exec",
  "text": "window.myData.value",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "javascript_exec",
  "code": "window.myData.value",
  "result": 42
}
```

---

**Example 5: Call page function**

**Input:**
```json
{
  "action": "javascript_exec",
  "text": "window.submitForm()",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "javascript_exec",
  "code": "window.submitForm()",
  "result": {
    "formSubmitted": true,
    "validationsPassed": true,
    "redirectUrl": "/success"
  }
}
```

---

**Example 6: Get all form values**

**Input:**
```json
{
  "action": "javascript_exec",
  "text": "Array.from(document.querySelectorAll('input')).map(el => ({ name: el.name, value: el.value }))",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "javascript_exec",
  "code": "Array.from(document.querySelectorAll('input')).map(el => ({ name: el.name, value: el.value }))",
  "result": [
    {
      "name": "firstName",
      "value": "John"
    },
    {
      "name": "lastName",
      "value": "Doe"
    },
    {
      "name": "email",
      "value": "john@example.com"
    },
    {
      "name": "phoneNumber",
      "value": "+1-555-0123"
    }
  ]
}
```

---

**Example 7: Check if element exists**

**Input:**
```json
{
  "action": "javascript_exec",
  "text": "!!document.querySelector('.error-message')",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "javascript_exec",
  "code": "!!document.querySelector('.error-message')",
  "result": false,
  "elementExists": false
}
```

---

**Example 8: Get all links on page**

**Input:**
```json
{
  "action": "javascript_exec",
  "text": "Array.from(document.querySelectorAll('a')).map(el => el.href)",
  "tabId": 563774466
}
```

**Output:**
```json
{
  "success": true,
  "action": "javascript_exec",
  "code": "Array.from(document.querySelectorAll('a')).map(el => el.href)",
  "result": [
    "https://example.com/",
    "https://example.com/about",
    "https://example.com/products",
    "https://example.com/contact",
    "https://example.com/blog"
  ]
}
```

---

**Use Cases:**

- **DOM Inspection:** Query page elements and read their properties
- **Page Interaction:** Call JavaScript functions defined on the page
- **Data Extraction:** Extract data from page variables
- **Dynamic Modification:** Change element styles or content
- **Form Analysis:** Get values from form fields programmatically
- **Page State:** Check for element existence and visibility

---

## 17. turn_answer_start

**Description:** Call this immediately before your text response to the user for this turn.

**Example 1: Call before response**

**Input:**
```json
{}
```

**Output:**
```
[No output - signals that the response can proceed]
```

---

**Usage Notes:**

- Call this tool as the first action before writing any response text
- Required for every turn, whether or not other tools were called
- No parameters needed
- After calling, proceed with your text response
- Do not make any additional tool calls after calling turn_answer_start

---

**Use Cases:**

- **Response Flow:** Properly sequence tool calls with text responses
- **Output Management:** Ensure correct formatting of multi-part responses
- **Turn Completion:** Mark the transition to final user-facing output