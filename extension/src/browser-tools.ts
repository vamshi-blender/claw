import type { PendingToolRequest, ToolResultPayload } from "@/types/chat"

type ToolArgs = Record<string, unknown>

const storedImages = new Map<string, { dataUrl: string; filename: string; mimeType: string }>()

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`
}

function asRecord(value: unknown): ToolArgs {
  return value && typeof value === "object" ? (value as ToolArgs) : {}
}

function asNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback
}

function asTuple2(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined
  }

  const [x, y] = value
  return typeof x === "number" && typeof y === "number" ? [x, y] : undefined
}

function asTuple4(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) {
    return undefined
  }

  const [x0, y0, x1, y1] = value
  return [x0, y0, x1, y1].every((item) => typeof item === "number")
    ? [x0, y0, x1, y1]
    : undefined
}

async function waitForTabLoad(tabId: number, timeoutMs = 15000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId)
    if (tab.status === "complete") {
      return tab
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  return chrome.tabs.get(tabId)
}

async function getTabInWindow(tabId: number, windowId: number) {
  const tab = await chrome.tabs.get(tabId)
  if (tab.windowId !== windowId) {
    throw new Error(`Tab ${tabId} is outside this chat window.`)
  }
  return tab
}

async function runInTab<Args extends unknown[], T>(
  tabId: number,
  func: (...args: Args) => T,
  args: Args,
  world?: `${chrome.scripting.ExecutionWorld}`,
) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
    ...(world ? { world } : {}),
  })

  return result?.result as Awaited<T>
}

function normalizeUrl(input: string) {
  const value = input.trim()
  if (value === "back" || value === "forward") {
    return value
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return value
  }
  return `https://${value}`
}

async function tabsContext(windowId: number) {
  const tabs = await chrome.tabs.query({ windowId })
  const activeTab = tabs.find((tab) => tab.active)

  return {
    lockedWindowId: windowId,
    initialTabId: activeTab?.id ?? null,
    availableTabs: tabs
      .filter((tab) => typeof tab.id === "number")
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((tab) => ({
        tabId: tab.id,
        title: tab.title ?? "",
        url: tab.url ?? "",
        active: Boolean(tab.active),
      })),
  }
}

async function tabsCreate(windowId: number, args: ToolArgs) {
  const url = asString(args.url)
  const tab = await chrome.tabs.create({
    windowId,
    active: true,
    ...(url ? { url: normalizeUrl(url) } : {}),
  })

  if (tab.id) {
    await waitForTabLoad(tab.id).catch(() => tab)
  }

  return {
    tabId: tab.id ?? null,
    title: tab.title ?? "",
    url: tab.url ?? "",
  }
}

async function navigate(windowId: number, args: ToolArgs) {
  const tabId = asNumber(args.tabId)
  const url = normalizeUrl(asString(args.url))
  await getTabInWindow(tabId, windowId)

  if (url === "back") {
    await chrome.tabs.goBack(tabId)
  } else if (url === "forward") {
    await chrome.tabs.goForward(tabId)
  } else {
    await chrome.tabs.update(tabId, { active: true, url })
  }

  const tab = await waitForTabLoad(tabId).catch(() => chrome.tabs.get(tabId))
  return {
    tabId,
    title: tab.title ?? "",
    url: tab.url ?? "",
    status: tab.status ?? "",
  }
}

async function resizeWindow(windowId: number, args: ToolArgs) {
  const tabId = asNumber(args.tabId)
  await getTabInWindow(tabId, windowId)

  const width = asNumber(args.width)
  const height = asNumber(args.height)
  const previous = await chrome.windows.get(windowId)
  const updated = await chrome.windows.update(windowId, {
    width,
    height,
    state: "normal",
  })

  return {
    previous: { width: previous.width ?? null, height: previous.height ?? null },
    current: { width: updated.width ?? width, height: updated.height ?? height },
  }
}

async function getPageText(windowId: number, args: ToolArgs) {
  const tabId = asNumber(args.tabId)
  await getTabInWindow(tabId, windowId)
  const maxChars = asNumber(args.max_chars, 50000)

  return runInTab(
    tabId,
    (limit: number) => {
      const clean = (value: string) => value.replace(/\s+/g, " ").trim()
      const target = document.querySelector("article") ?? document.querySelector("main") ?? document.body
      const text = clean((target?.textContent ?? "").slice(0, limit + 1))
      return text.length > limit
        ? {
            error: `Page text exceeded ${limit} characters. Increase max_chars or narrow the page.`,
          }
        : text
    },
    [maxChars],
  )
}

async function readPage(windowId: number, args: ToolArgs) {
  const tabId = asNumber(args.tabId)
  await getTabInWindow(tabId, windowId)

  return runInTab(
    tabId,
    (options: {
      depth: number
      filter: "interactive" | "all"
      maxChars: number
      refId?: string
    }) => {
      const hash = (input: string) => {
        let value = 0
        for (let index = 0; index < input.length; index += 1) {
          value = (value << 5) - value + input.charCodeAt(index)
          value |= 0
        }
        return Math.abs(value).toString(36)
      }
      const pathFor = (element: Element) => {
        const segments: string[] = []
        let current: Element | null = element
        while (current) {
          const parent: Element | null = current.parentElement
          const index = parent ? Array.from(parent.children).indexOf(current) : 0
          segments.push(`${current.tagName.toLowerCase()}:${Math.max(index, 0)}`)
          current = parent
        }
        return segments.reverse().join(">")
      }
      const refFor = (element: Element) => `ref_${hash(pathFor(element))}`
      const nameFor = (element: Element) => {
        const input = element as HTMLInputElement
        return (
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.getAttribute("alt") ||
          input.placeholder ||
          element.textContent ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 180)
      }
      const roleFor = (element: Element) => {
        const role = element.getAttribute("role")
        if (role) return role
        const tag = element.tagName.toLowerCase()
        if (tag === "a") return "link"
        if (tag === "input" || tag === "textarea") return "textbox"
        return tag
      }
      const isInteractive = (element: Element) => {
        const tag = element.tagName.toLowerCase()
        const role = (element.getAttribute("role") || "").toLowerCase()
        return (
          ["a", "button", "input", "textarea", "select", "summary"].includes(tag) ||
          ["button", "link", "checkbox", "radio", "textbox", "combobox", "menuitem"].includes(role) ||
          element.hasAttribute("tabindex") ||
          (element as HTMLElement).isContentEditable
        )
      }
      const isVisible = (element: Element) => {
        const style = window.getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        )
      }
      const summaryFor = (element: Element) => {
        const rect = element.getBoundingClientRect()
        const input = element as HTMLInputElement
        return {
          ref: refFor(element),
          type: roleFor(element),
          name: nameFor(element),
          visible: isVisible(element),
          bounds: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          ...(input.value ? { value: input.value } : {}),
          ...(input.type ? { inputType: input.type } : {}),
        }
      }
      const root = options.refId
        ? Array.from(document.querySelectorAll("*")).find((element) => refFor(element) === options.refId)
        : document.body
      const elements = Array.from((root ?? document.body).querySelectorAll("*"))
      const nodes = elements
        .filter((element) => options.filter === "all" || isInteractive(element))
        .slice(0, 250)
        .map(summaryFor)
      const output = {
        url: location.href,
        title: document.title,
        elements: nodes,
      }
      const text = JSON.stringify(output)
      return text.length > options.maxChars
        ? {
            error: `Page summary exceeded ${options.maxChars} characters. Use filter='interactive' or a smaller ref_id.`,
          }
        : output
    },
    [
      {
        depth: asNumber(args.depth, 8),
        filter: args.filter === "all" ? "all" : "interactive",
        maxChars: asNumber(args.max_chars, 20000),
        refId: asString(args.ref_id) || undefined,
      },
    ],
  )
}

async function findElements(windowId: number, args: ToolArgs) {
  const tabId = asNumber(args.tabId)
  await getTabInWindow(tabId, windowId)

  return runInTab(
    tabId,
    (query: string) => {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
      const hash = (input: string) => {
        let value = 0
        for (let index = 0; index < input.length; index += 1) {
          value = (value << 5) - value + input.charCodeAt(index)
          value |= 0
        }
        return Math.abs(value).toString(36)
      }
      const pathFor = (element: Element) => {
        const segments: string[] = []
        let current: Element | null = element
        while (current) {
          const parent: Element | null = current.parentElement
          const index = parent ? Array.from(parent.children).indexOf(current) : 0
          segments.push(`${current.tagName.toLowerCase()}:${Math.max(index, 0)}`)
          current = parent
        }
        return segments.reverse().join(">")
      }
      const textFor = (element: Element) =>
        [
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("alt"),
          (element as HTMLInputElement).placeholder,
          element.textContent,
        ]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
      const matches = Array.from(document.querySelectorAll("*"))
        .map((element) => {
          const text = textFor(element)
          const haystack = `${element.tagName} ${element.getAttribute("role") ?? ""} ${text}`.toLowerCase()
          const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0)
          return { element, text, score }
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)

      return {
        query,
        count: matches.length,
        matches: matches.map(({ element, text }) => {
          const rect = element.getBoundingClientRect()
          return {
            ref: `ref_${hash(pathFor(element))}`,
            type: element.getAttribute("role") || element.tagName.toLowerCase(),
            name: text.slice(0, 180),
            bounds: {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          }
        }),
      }
    },
    [asString(args.query)],
  )
}

async function formInput(windowId: number, args: ToolArgs) {
  const tabId = asNumber(args.tabId)
  await getTabInWindow(tabId, windowId)

  return runInTab(
    tabId,
    (ref: string, value: string | number | boolean) => {
      const hash = (input: string) => {
        let output = 0
        for (let index = 0; index < input.length; index += 1) {
          output = (output << 5) - output + input.charCodeAt(index)
          output |= 0
        }
        return Math.abs(output).toString(36)
      }
      const pathFor = (element: Element) => {
        const segments: string[] = []
        let current: Element | null = element
        while (current) {
          const parent: Element | null = current.parentElement
          const index = parent ? Array.from(parent.children).indexOf(current) : 0
          segments.push(`${current.tagName.toLowerCase()}:${Math.max(index, 0)}`)
          current = parent
        }
        return segments.reverse().join(">")
      }
      const target = Array.from(document.querySelectorAll("*")).find(
        (element) => `ref_${hash(pathFor(element))}` === ref,
      )
      if (!target) {
        return { success: false, error: `Element ${ref} was not found.` }
      }

      if (target instanceof HTMLInputElement) {
        if (target.type === "checkbox" || target.type === "radio") {
          target.checked = Boolean(value)
        } else {
          target.value = String(value)
        }
      } else if (target instanceof HTMLTextAreaElement) {
        target.value = String(value)
      } else if (target instanceof HTMLSelectElement) {
        target.value = String(value)
      } else if ((target as HTMLElement).isContentEditable) {
        target.textContent = String(value)
      } else {
        return { success: false, error: `Element ${ref} is not editable.` }
      }

      target.dispatchEvent(new Event("input", { bubbles: true }))
      target.dispatchEvent(new Event("change", { bubbles: true }))
      return { success: true, ref, value }
    },
    [asString(args.ref), args.value as string | number | boolean],
  )
}

async function computer(windowId: number, args: ToolArgs) {
  const tabId = asNumber(args.tabId)
  await getTabInWindow(tabId, windowId)
  const action = asString(args.action)

  if (action === "screenshot") {
    await chrome.tabs.update(tabId, { active: true })
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" })
    const imageId = createId("img")
    storedImages.set(imageId, { dataUrl, filename: `${imageId}.png`, mimeType: "image/png" })
    return { success: true, action, imageId, note: "Screenshot captured and stored for upload_image." }
  }

  if (action === "wait") {
    const duration = Math.min(asNumber(args.duration, 1), 30)
    await new Promise((resolve) => setTimeout(resolve, duration * 1000))
    return { success: true, action, duration }
  }

  return runInTab(
    tabId,
    (options: {
      action: string
      coordinate?: [number, number]
      startCoordinate?: [number, number]
      region?: [number, number, number, number]
      ref?: string
      text?: string
      scrollDirection?: string
      scrollAmount?: number
      repeat?: number
    }) => {
      const hash = (input: string) => {
        let output = 0
        for (let index = 0; index < input.length; index += 1) {
          output = (output << 5) - output + input.charCodeAt(index)
          output |= 0
        }
        return Math.abs(output).toString(36)
      }
      const pathFor = (element: Element) => {
        const segments: string[] = []
        let current: Element | null = element
        while (current) {
          const parent: Element | null = current.parentElement
          const index = parent ? Array.from(parent.children).indexOf(current) : 0
          segments.push(`${current.tagName.toLowerCase()}:${Math.max(index, 0)}`)
          current = parent
        }
        return segments.reverse().join(">")
      }
      const byRef = (ref?: string) =>
        ref
          ? Array.from(document.querySelectorAll("*")).find(
              (element) => `ref_${hash(pathFor(element))}` === ref,
            )
          : undefined
      const targetFromOptions = () => {
        const refTarget = byRef(options.ref)
        if (refTarget) return refTarget
        if (options.coordinate) {
          return document.elementFromPoint(options.coordinate[0], options.coordinate[1])
        }
        return document.activeElement
      }
      const click = (button = 0, detail = 1) => {
        const target = targetFromOptions()
        if (!target) return { success: false, error: "No click target found." }
        const rect = target.getBoundingClientRect()
        const x = options.coordinate?.[0] ?? rect.left + rect.width / 2
        const y = options.coordinate?.[1] ?? rect.top + rect.height / 2
        target.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y, button, detail }),
        )
        target.dispatchEvent(
          new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: x, clientY: y, button, detail }),
        )
        target.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, button, detail }),
        )
        return { success: true, action: options.action, target: target.tagName.toLowerCase() }
      }

      if (options.action === "left_click") return click(0, 1)
      if (options.action === "right_click") return click(2, 1)
      if (options.action === "double_click") return click(0, 2)
      if (options.action === "triple_click") return click(0, 3)
      if (options.action === "hover") {
        const target = targetFromOptions()
        if (!target) return { success: false, error: "No hover target found." }
        const rect = target.getBoundingClientRect()
        target.dispatchEvent(
          new MouseEvent("mouseover", {
            bubbles: true,
            clientX: options.coordinate?.[0] ?? rect.left + rect.width / 2,
            clientY: options.coordinate?.[1] ?? rect.top + rect.height / 2,
          }),
        )
        return { success: true, action: options.action }
      }
      if (options.action === "scroll" || options.action === "scroll_to") {
        const amount = (options.scrollAmount ?? 3) * 420
        if (options.action === "scroll_to") {
          const target = byRef(options.ref)
          target?.scrollIntoView({ block: "center", inline: "center" })
          return { success: Boolean(target), action: options.action, ref: options.ref }
        }
        const direction = options.scrollDirection ?? "down"
        window.scrollBy({
          left: direction === "left" ? -amount : direction === "right" ? amount : 0,
          top: direction === "up" ? -amount : direction === "down" ? amount : 0,
          behavior: "smooth",
        })
        return { success: true, action: options.action, direction }
      }
      if (options.action === "type") {
        const target = targetFromOptions() as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null
        if (!target) return { success: false, error: "No active target for typing." }
        const text = options.text ?? ""
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          target.value += text
        } else if (target.isContentEditable) {
          target.textContent = `${target.textContent ?? ""}${text}`
        } else {
          return { success: false, error: "Target is not editable." }
        }
        target.dispatchEvent(new Event("input", { bubbles: true }))
        return { success: true, action: options.action, textLength: text.length }
      }
      if (options.action === "key") {
        const target = (document.activeElement ?? document.body) as HTMLElement
        const keys = (options.text ?? "").split(/\s+/).filter(Boolean)
        const repeat = options.repeat ?? 1
        for (let index = 0; index < repeat; index += 1) {
          for (const key of keys) {
            target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
            target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }))
          }
        }
        return { success: true, action: options.action, keys, repeat }
      }
      if (options.action === "zoom") {
        return { success: true, action: options.action, note: "Use screenshot; zoom crop is not implemented in this foundation pass." }
      }
      if (options.action === "left_click_drag") {
        return { success: false, action: options.action, error: "Drag is not implemented in this foundation pass." }
      }

      return { success: false, error: `Unsupported computer action '${options.action}'.` }
    },
    [
      {
        action,
        coordinate: asTuple2(args.coordinate),
        startCoordinate: asTuple2(args.start_coordinate),
        region: asTuple4(args.region),
        ref: asString(args.ref) || undefined,
        text: asString(args.text),
        scrollDirection: asString(args.scroll_direction) || undefined,
        scrollAmount: asNumber(args.scroll_amount, 3),
        repeat: asNumber(args.repeat, 1),
      },
    ],
  )
}

async function uploadImage(windowId: number, args: ToolArgs) {
  const tabId = asNumber(args.tabId)
  await getTabInWindow(tabId, windowId)

  const imageId = asString(args.imageId)
  const image = storedImages.get(imageId)
  if (!image) {
    return { success: false, error: `Stored image ${imageId} was not found.` }
  }

  return {
    success: false,
    imageId,
    error:
      "Programmatic image upload is not enabled yet. The image is stored in extension memory for a future upload implementation.",
  }
}

async function readConsoleMessages(windowId: number, args: ToolArgs) {
  const tabId = asNumber(args.tabId)
  await getTabInWindow(tabId, windowId)

  return {
    success: true,
    action: "read_console_messages",
    messagesCount: 0,
    messages: [],
    note: "Console capture requires an injected monitor/debugger session and is not enabled yet.",
  }
}

async function readNetworkRequests(windowId: number, args: ToolArgs) {
  const tabId = asNumber(args.tabId)
  await getTabInWindow(tabId, windowId)

  return runInTab(
    tabId,
    (options: { limit: number; urlPattern?: string }) => {
      const entries = performance
        .getEntriesByType("resource")
        .filter((entry) => !options.urlPattern || entry.name.includes(options.urlPattern))
        .slice(-options.limit)
        .map((entry) => ({
          url: entry.name,
          startTime: Math.round(entry.startTime),
          duration: Math.round(entry.duration),
          initiatorType: (entry as PerformanceResourceTiming).initiatorType,
        }))

      return {
        success: true,
        action: "read_network_requests",
        requestsCount: entries.length,
        requests: entries,
      }
    },
    [
      {
        limit: asNumber(args.limit, 100),
        urlPattern: asString(args.urlPattern) || undefined,
      },
    ],
  )
}

async function javascriptTool(windowId: number, args: ToolArgs) {
  const tabId = asNumber(args.tabId)
  await getTabInWindow(tabId, windowId)

  if (args.action !== "javascript_exec") {
    return { success: false, error: "Expected action='javascript_exec'." }
  }

  return runInTab(
    tabId,
    (code: string) => {
      try {
        const result = (0, eval)(code)
        return { success: true, result: result === undefined ? "undefined" : result }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
    [asString(args.text)],
    chrome.scripting.ExecutionWorld.MAIN,
  )
}

export async function executeBrowserTool(
  request: PendingToolRequest,
  windowId: number,
): Promise<ToolResultPayload> {
  try {
    const args = asRecord(request.input)
    let output: unknown

    switch (request.name) {
      case "tabs_context":
        output = await tabsContext(windowId)
        break
      case "tabs_create":
        output = await tabsCreate(windowId, args)
        break
      case "navigate":
        output = await navigate(windowId, args)
        break
      case "resize_window":
        output = await resizeWindow(windowId, args)
        break
      case "get_page_text":
        output = await getPageText(windowId, args)
        break
      case "read_page":
        output = await readPage(windowId, args)
        break
      case "find":
        output = await findElements(windowId, args)
        break
      case "form_input":
        output = await formInput(windowId, args)
        break
      case "computer":
        output = await computer(windowId, args)
        break
      case "upload_image":
        output = await uploadImage(windowId, args)
        break
      case "file_upload":
        output = {
          success: false,
          error:
            "Local path file upload is not available from a normal Chrome extension without user-selected files or native messaging.",
        }
        break
      case "read_console_messages":
        output = await readConsoleMessages(windowId, args)
        break
      case "read_network_requests":
        output = await readNetworkRequests(windowId, args)
        break
      case "javascript_tool":
        output = await javascriptTool(windowId, args)
        break
      case "turn_answer_start":
        output = { success: true, readyForResponse: true }
        break
      default:
        output = { success: false, error: `Unknown tool ${request.name}.` }
    }

    return { ok: true, output }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Tool execution failed.",
    }
  }
}
