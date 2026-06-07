import React from "react"

type ExtensionTheme = "light" | "dark"

const EXTENSION_THEME_KEY = "extensionTheme"

function isExtensionTheme(value: unknown): value is ExtensionTheme {
  return value === "light" || value === "dark"
}

function getPreferredTheme(): ExtensionTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

function applyTheme(theme: ExtensionTheme) {
  document.documentElement.classList.toggle("dark", theme === "dark")
  document.documentElement.style.colorScheme = theme
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
}

function ExtensionThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = React.useState<ExtensionTheme>(() => getPreferredTheme())

  React.useEffect(() => {
    let isMounted = true

    async function loadTheme() {
      const items = await chrome.storage.sync.get([EXTENSION_THEME_KEY])
      const nextTheme = isExtensionTheme(items[EXTENSION_THEME_KEY])
        ? items[EXTENSION_THEME_KEY]
        : getPreferredTheme()

      if (isMounted) {
        setTheme(nextTheme)
      }
    }

    void loadTheme()

    return () => {
      isMounted = false
    }
  }, [])

  React.useEffect(() => {
    applyTheme(theme)
  }, [theme])

  React.useEffect(() => {
    function onStorageChanged(
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) {
      if (areaName !== "sync") {
        return
      }

      const nextTheme = changes[EXTENSION_THEME_KEY]?.newValue
      if (isExtensionTheme(nextTheme)) {
        setTheme(nextTheme)
      }
    }

    chrome.storage.onChanged.addListener(onStorageChanged)

    return () => {
      chrome.storage.onChanged.removeListener(onStorageChanged)
    }
  }, [])

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) {
        return
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      if (event.key.toLowerCase() !== "d") {
        return
      }

      if (isTypingTarget(event.target)) {
        return
      }

      setTheme((currentTheme) => {
        const nextTheme = currentTheme === "dark" ? "light" : "dark"
        void chrome.storage.sync.set({ [EXTENSION_THEME_KEY]: nextTheme })
        return nextTheme
      })
    }

    window.addEventListener("keydown", onKeyDown)

    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [])

  return children
}

export { ExtensionThemeProvider }
