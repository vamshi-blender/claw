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