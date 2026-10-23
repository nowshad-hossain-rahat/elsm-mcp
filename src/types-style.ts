/**
 * Web-storage areas the bridge speaks about. Cookies are deliberately absent:
 * they are the separate read_cookies tool with its own consent rules.
 */
export type StorageArea = "localStorage" | "sessionStorage";
