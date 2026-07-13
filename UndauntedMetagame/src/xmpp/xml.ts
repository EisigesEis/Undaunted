export type XmppNode = {
    name: string;
    attrs: Record<string, string>;
    children: Array<XmppNode | string>;
};

export function escapeXml(value: string) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

export function attr(name: string, value: string | undefined) {
    if (value == undefined) {
        return "";
    }

    return ` ${name}="${escapeXml(value)}"`;
}

export function nodeText(node: XmppNode, childName: string) {
    const Child = node.children.find((Child) => typeof Child !== "string" && Child.name === childName);
    if (Child == undefined || typeof Child === "string") {
        return undefined;
    }

    return Child.children.filter((ChildPart) => typeof ChildPart === "string").join("");
}

export function findChild(node: XmppNode, childName: string) {
    return node.children.find((Child) => typeof Child !== "string" && Child.name === childName) as XmppNode | undefined;
}

export function findDescendant(node: XmppNode, childName: string): XmppNode | undefined {
    for (const Child of node.children) {
        if (typeof Child === "string") {
            continue;
        }

        if (Child.name === childName) {
            return Child;
        }

        const Descendant = findDescendant(Child, childName);
        if (Descendant != undefined) {
            return Descendant;
        }
    }

    return undefined;
}

export function parseOpeningTag(rawXml: string): XmppNode | undefined {
    const Match = rawXml.match(/^<([A-Za-z_][\w:.-]*)([^>]*)>/);
    if (Match == undefined) {
        return undefined;
    }

    const Attrs: Record<string, string> = {};
    const AttrSource = Match[2];
    const AttrRegex = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let AttrMatch: RegExpExecArray | null;
    while ((AttrMatch = AttrRegex.exec(AttrSource)) != undefined) {
        Attrs[AttrMatch[1]] = AttrMatch[3] ?? AttrMatch[4] ?? "";
    }

    return {
        name: Match[1],
        attrs: Attrs,
        children: []
    };
}

