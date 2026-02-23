/**
 * Minimal Chrome Extension API type declarations for SuperSurf
 */

interface ChromeDebugger {
  attach(target: { tabId: number }, requiredVersion: string): Promise<void>;
  detach(target: { tabId: number }): Promise<void>;
  sendCommand(target: { tabId: number }, method: string, params?: any): Promise<any>;
  onEvent: {
    addListener(callback: (source: { tabId: number }, method: string, params: any) => void): void;
  };
  onDetach: {
    addListener(callback: (source: { tabId: number }, reason: string) => void): void;
  };
}

declare namespace chrome {
  namespace runtime {
    function getManifest(): { name: string; version: string; [key: string]: any };
    function sendMessage(message: any, callback?: (response: any) => void): void;
    const onMessage: {
      addListener(callback: (message: any, sender: any, sendResponse?: (response: any) => void) => void): void;
    };
    const onInstalled: {
      addListener(callback: (details: { reason: string }) => void): void;
    };
    const id: string;
    const lastError: { message?: string } | undefined;
    function getURL(path: string): string;
  }

  namespace storage {
    interface StorageArea {
      get(keys: string | string[]): Promise<Record<string, any>>;
      set(items: Record<string, any>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea;
    const onChanged: {
      addListener(callback: (changes: Record<string, { oldValue?: any; newValue?: any }>, areaName: string) => void): void;
    };
  }

  namespace tabs {
    interface Tab {
      id?: number;
      index: number;
      title?: string;
      url?: string;
      windowId: number;
      active: boolean;
      groupId: number; // -1 when ungrouped
    }
    function query(queryInfo: Record<string, any>): Promise<Tab[]>;
    function create(createProperties: Record<string, any>): Promise<Tab>;
    function update(tabId: number, updateProperties: Record<string, any>): Promise<Tab>;
    function remove(tabId: number): Promise<void>;
    function get(tabId: number): Promise<Tab>;
    function reload(tabId: number): Promise<void>;
    function goBack(tabId: number): Promise<void>;
    function group(options: { tabIds: number | number[]; groupId?: number; createProperties?: { windowId?: number } }): Promise<number>;
    function ungroup(tabIds: number | number[]): Promise<void>;
    const onActivated: {
      addListener(callback: (activeInfo: { tabId: number; windowId: number }) => void): void;
    };
    const onRemoved: {
      addListener(callback: (tabId: number, removeInfo: any) => void): void;
    };
    const onUpdated: {
      addListener(callback: (tabId: number, changeInfo: any, tab: Tab) => void): void;
      removeListener(callback: (tabId: number, changeInfo: any, tab: Tab) => void): void;
    };
  }

  namespace tabGroups {
    type Color = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';
    interface TabGroup {
      id: number;
      collapsed: boolean;
      color: Color;
      title?: string;
      windowId: number;
    }
    const TAB_GROUP_ID_NONE: -1;
    function get(groupId: number): Promise<TabGroup>;
    function update(groupId: number, updateProperties: { title?: string; color?: Color; collapsed?: boolean }): Promise<TabGroup>;
    function query(queryInfo: { title?: string; color?: Color; windowId?: number; collapsed?: boolean }): Promise<TabGroup[]>;
    function move(groupId: number, moveProperties: { index: number; windowId?: number }): Promise<TabGroup>;
    const onCreated: {
      addListener(callback: (group: TabGroup) => void): void;
    };
    const onRemoved: {
      addListener(callback: (group: TabGroup) => void): void;
    };
    const onUpdated: {
      addListener(callback: (group: TabGroup) => void): void;
    };
  }

  namespace windows {
    function update(windowId: number, updateInfo: Record<string, any>): Promise<any>;
    function remove(windowId: number): Promise<void>;
  }

  namespace scripting {
    interface ScriptInjection {
      target: { tabId: number };
      func?: (...args: any[]) => any;
      args?: any[];
      world?: string;
      files?: string[];
    }
    function executeScript(injection: ScriptInjection): Promise<Array<{ result: any }>>;
  }

  namespace action {
    function setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>;
    function setTitle(details: { title: string; tabId?: number }): Promise<void>;
    function setIcon(details: { path: string | Record<string, string>; tabId?: number }): Promise<void>;
  }

  namespace management {
    interface ExtensionInfo {
      id: string;
      name: string;
      enabled: boolean;
      type: string;
      installType: string;
    }
    function getAll(): Promise<ExtensionInfo[]>;
    function setEnabled(id: string, enabled: boolean): Promise<void>;
  }

  namespace webRequest {
    interface WebRequestBodyDetails {
      requestId: string;
      url: string;
      method: string;
      type: string;
      timeStamp: number;
      requestBody?: any;
    }
    interface WebRequestHeadersDetails {
      requestId: string;
      requestHeaders?: Array<{ name: string; value?: string }>;
    }
    interface WebResponseCacheDetails {
      requestId: string;
      statusCode: number;
      statusLine: string;
      responseHeaders?: Array<{ name: string; value?: string }>;
    }
    interface WebResponseErrorDetails {
      requestId: string;
      error: string;
    }
    const onBeforeRequest: {
      addListener(callback: (details: WebRequestBodyDetails) => void, filter: any, extraInfoSpec?: string[]): void;
    };
    const onBeforeSendHeaders: {
      addListener(callback: (details: WebRequestHeadersDetails) => void, filter: any, extraInfoSpec?: string[]): void;
    };
    const onCompleted: {
      addListener(callback: (details: WebResponseCacheDetails) => void, filter: any, extraInfoSpec?: string[]): void;
    };
    const onErrorOccurred: {
      addListener(callback: (details: WebResponseErrorDetails) => void, filter: any): void;
    };
  }

  namespace webNavigation {
    interface WebNavigationDetails {
      tabId: number;
      url: string;
      frameId: number;
      timeStamp: number;
    }
    const onBeforeNavigate: {
      addListener(callback: (details: WebNavigationDetails) => void): void;
    };
    const onCommitted: {
      addListener(callback: (details: WebNavigationDetails) => void): void;
    };
    const onCompleted: {
      addListener(callback: (details: WebNavigationDetails) => void): void;
    };
  }

  namespace downloads {
    interface DownloadOptions {
      url: string;
      filename?: string;
      saveAs?: boolean;
    }
    interface DownloadItem {
      id: number;
      filename: string;
      fileSize: number;
      mime: string;
      state: string;
      error?: string;
    }
    interface DownloadDelta {
      id: number;
      state?: { previous: string; current: string };
    }
    function download(options: DownloadOptions, callback: (downloadId: number | undefined) => void): void;
    function search(query: { id: number }, callback: (items: DownloadItem[]) => void): void;
    const onChanged: {
      addListener(callback: (delta: DownloadDelta) => void): void;
      removeListener(callback: (delta: DownloadDelta) => void): void;
    };
  }

  namespace alarms {
    function create(name: string, alarmInfo: { delayInMinutes?: number; periodInMinutes?: number; when?: number }): void;
    function clear(name: string): Promise<boolean>;
    const onAlarm: {
      addListener(callback: (alarm: { name: string }) => void): void;
    };
  }
}
