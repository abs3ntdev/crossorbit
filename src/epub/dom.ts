// The subset of htmlparser2 DOM nodes the EPUB text mapping walks. Offsets are UTF-16 code units.

export interface DomNode {
  type?: string;
  name?: string;
  attribs?: Record<string, string | undefined>;
  data?: string;
  parent?: DomNode | null;
  children?: DomNode[];
}

export interface RangePoint {
  node: DomNode;
  offset: number;
}

export function isTextNode(node: DomNode | null | undefined): boolean {
  return node?.type === 'text' || node?.type === 'cdata';
}

export function isElementNode(node: DomNode | null | undefined): boolean {
  return node?.type === 'tag' || node?.type === 'script' || node?.type === 'style';
}

export function getDocumentElement(root: DomNode): DomNode | null {
  if (root.type === 'root') {
    return (root.children ?? []).find((child) => isElementNode(child)) ?? null;
  }
  let current = root;
  while (current.parent && current.parent.type !== 'root') {
    current = current.parent;
  }
  return current;
}
