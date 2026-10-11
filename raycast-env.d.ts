/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Starting folder - Folder to open when the command starts */
  "startingPath": string,
  /** View options - Show hidden files by default */
  "showHiddenDefault": boolean,
  /** Transfer start folder - Where the Tab transfer tree starts browsing */
  "transferStart": "home" | "current"
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `browse-files` command */
  export type BrowseFiles = ExtensionPreferences & {}
  /** Preferences accessible in the `finder-selection` command */
  export type FinderSelection = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `browse-files` command */
  export type BrowseFiles = {}
  /** Arguments passed to the `finder-selection` command */
  export type FinderSelection = {}
}

