export type DocType =
  | "plain"
  | "newnote"
  | "notes"
  | "leaf"
  | "chunkpack"
  | "versioninfo"
  | "syncinfo"
  | "sync-parameters"
  | "milestoneinfo"
  | "nodeinfo";

export interface EntryLeaf {
  _id: string;
  _rev?: string;
  type: "leaf";
  data: string;
  e_?: boolean;
}

export type Eden = Record<string, { data: string; epoch: number }>;

export interface PlainEntry {
  _id: string;
  _rev?: string;
  type: "plain";
  path: string;
  children?: string[];
  ctime?: number;
  mtime?: number;
  size?: number;
  eden?: Eden;
  _deleted?: boolean;
  _conflicts?: string[];
  deleted?: boolean;
}

export interface NewnoteEntry {
  _id: string;
  _rev?: string;
  type: "newnote";
  path: string;
  children?: string[];
  ctime?: number;
  mtime?: number;
  size?: number;
  eden?: Eden;
  _deleted?: boolean;
  _conflicts?: string[];
  deleted?: boolean;
}

export interface NotesEntry {
  _id: string;
  _rev?: string;
  type: "notes";
  path: string;
  data?: string;
  ctime?: number;
  mtime?: number;
  _deleted?: boolean;
  _conflicts?: string[];
}

export type MetaDoc = PlainEntry | NewnoteEntry | NotesEntry;

export type DocClass = "post" | "image" | "ignored";

export interface ReconstructedText {
  text: string;
  path: string;
  mtime: number;
}

export interface ReconstructedBinary {
  buffer: Buffer;
  path: string;
  mtime: number;
  size: number;
}
