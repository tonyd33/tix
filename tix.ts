import { basename, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { parseArgs } from "node:util";

const README = "README.md";
const INDEX_BEGIN = "<!-- BEGIN tix index -->";
const INDEX_END = "<!-- END tix index -->";
const INDEX_WIDTH = 76;
const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type Status = "open" | "in-progress" | "resolved" | "wontfix";
type Kind = "bug" | "feature";

const STATUSES: readonly Status[] = ["open", "in-progress", "resolved", "wontfix"];
const KINDS: readonly Kind[] = ["bug", "feature"];

const REQUIRED_FIELDS = ["created-at", "status", "kind", "priority", "summary"];

const STATUS_HEADINGS: Record<Status, string> = {
  open: "Open",
  "in-progress": "In progress",
  resolved: "Resolved",
  wontfix: "Won't fix",
};

const USAGE = {
  show: "usage: tix show <stem>",
  deps: "usage: tix deps <stem> [--reverse] [--depth n]",
  new: "usage: tix new <stem> --summary s [--kind k] [--priority n] [--title t]",
  close: "usage: tix close <stem> resolved|wontfix",
  set: "usage: tix set <stem> key=value ...",
};

type Ticket = Readonly<{
  stem: string;
  createdAt: string;
  status: Status;
  kind: Kind;
  priority: number;
  summary: string;
  branch?: string;
  closed?: string;
  dependsOn: readonly string[];
  tags: readonly string[];
  body: string;
}>;

type Tickets = ReadonlyMap<string, Ticket>;

/** Everything a command reads, loaded before it runs. */
type Workspace = Readonly<{
  dir: string;
  tickets: Tickets;
  parseErrors: readonly string[];
  files: ReadonlyMap<string, string>;
  /** Link targets that exist on disk; loaded only for `check`. */
  existingLinks: ReadonlySet<string>;
  today: string;
}>;

/** What a command prints and writes; `perform` carries it out. */
type Outcome = Readonly<{
  stdout?: string;
  stderr?: string;
  writes?: ReadonlyMap<string, string>;
  exitCode?: number;
}>;

type Result<T, E = string> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: E }>;

/** A command's failure: 1 for tickets that are already broken, 2 for a bad request. */
type Failure = Readonly<{ exitCode: 1 | 2; message: string }>;

type Command = (args: string[], workspace: Workspace) => Result<Outcome, Failure>;
type TicketCommand = (args: string[], tickets: Tickets, workspace: Workspace) => Result<Outcome, Failure>;

function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

function map<T, U, E>(result: Result<T, E>, f: (value: T) => U): Result<U, E> {
  return result.ok ? ok(f(result.value)) : result;
}

function andThen<T, U, E>(result: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> {
  return result.ok ? f(result.value) : result;
}

function mapError<T, E, F>(result: Result<T, E>, f: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(f(result.error));
}

/** Returns every value, or the first error. */
function all<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  return results.reduce<Result<T[], E>>(
    (acc, result) => andThen(acc, values => map(result, value => [...values, value])),
    ok([]),
  );
}

/** Mark a failure as a bad request. Exits 2. */
function usage<T>(result: Result<T>): Result<T, Failure> {
  return mapError(result, message => ({ exitCode: 2, message }));
}

/** Mark a failure as a problem with the tickets on disk. Exits 1. */
function invalid<T>(result: Result<T>): Result<T, Failure> {
  return mapError(result, message => ({ exitCode: 1, message }));
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parseArgsSafely<T>(parse: () => T): Result<T> {
  try {
    return ok(parse());
  } catch (e) {
    return err(messageOf(e));
  }
}

function parseYaml(text: string): Result<unknown> {
  try {
    return ok(Bun.YAML.parse(text));
  } catch (e) {
    return err(messageOf(e));
  }
}

function problemIf(condition: boolean, problem: string): string[] {
  return condition ? [problem] : [];
}

function isClosed(status: Status): boolean {
  return status === "resolved" || status === "wontfix";
}

function stemOf(name: string): string {
  return basename(name, ".md");
}

function fileOf(stem: string): string {
  return `${stem}.md`;
}

function titleOf(ticket: Ticket): string | undefined {
  const first = ticket.body.split("\n").find(line => line.trim() !== "");
  return first?.startsWith("# ") ? first : undefined;
}

function quoted(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function parseNatural(text: string): number | undefined {
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

function parseStatus(value: unknown): Result<Status> {
  const status = STATUSES.find(s => s === value);
  return status === undefined ? err(`status is not one of ${STATUSES.join(", ")}: ${quoted(value)}`) : ok(status);
}

function parseKind(value: unknown): Result<Kind> {
  const kind = KINDS.find(k => k === value);
  return kind === undefined ? err(`kind is not one of ${KINDS.join(", ")}: ${quoted(value)}`) : ok(kind);
}

function parsePriority(value: unknown): Result<number> {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? ok(value)
    : err(`priority is not a non-negative integer: ${quoted(value)}`);
}

function parseDate(key: string, value: unknown): Result<string> {
  const failure = err(`${key} is not a YYYY-MM-DD date: ${quoted(value)}`);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return failure;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) ? ok(value) : failure;
}

function parseText(key: string, value: unknown): Result<string> {
  return typeof value === "string" ? ok(value) : err(`${key} is not text: ${quoted(value)}`);
}

function parseBranch(value: unknown): Result<string> {
  return typeof value === "string" && /^[\w./-]+$/.test(value)
    ? ok(value)
    : err(`branch is not a branch name: ${quoted(value)}`);
}

function parseStems(value: unknown): Result<string[]> {
  return Array.isArray(value) && value.every(stem => typeof stem === "string")
    ? ok(value)
    : err(`depends-on is not a list of tickets: ${quoted(value)}`);
}

function parseTags(value: unknown): Result<string[]> {
  return Array.isArray(value) && value.every(tag => typeof tag === "string" && KEBAB_CASE.test(tag))
    ? ok(value)
    : err(`tags is not a list of kebab-case tags: ${quoted(value)}`);
}

/** Returns `ticket` with one field set from its parsed YAML value. */
function withField(ticket: Ticket, key: string, value: unknown): Result<Ticket> {
  switch (key) {
    case "created-at":
      return map(parseDate(key, value), createdAt => ({ ...ticket, createdAt }));
    case "status":
      return map(parseStatus(value), status => ({ ...ticket, status }));
    case "kind":
      return map(parseKind(value), kind => ({ ...ticket, kind }));
    case "priority":
      return map(parsePriority(value), priority => ({ ...ticket, priority }));
    case "summary":
      return map(parseText(key, value), summary => ({ ...ticket, summary }));
    case "branch":
      return map(parseBranch(value), branch => ({ ...ticket, branch }));
    case "closed":
      return map(parseDate(key, value), closed => ({ ...ticket, closed }));
    case "depends-on":
      return map(parseStems(value), dependsOn => ({ ...ticket, dependsOn }));
    case "tags":
      return map(parseTags(value), tags => ({ ...ticket, tags }));
    default:
      return err(`unknown field ${key}`);
  }
}

function withoutField(ticket: Ticket, key: string): Result<Ticket> {
  switch (key) {
    case "branch":
      return ok({ ...ticket, branch: undefined });
    case "closed":
      return ok({ ...ticket, closed: undefined });
    case "depends-on":
      return ok({ ...ticket, dependsOn: [] });
    case "tags":
      return ok({ ...ticket, tags: [] });
    default:
      return err(REQUIRED_FIELDS.includes(key) ? `${key} is required` : `unknown field ${key}`);
  }
}

function splitList(text: string): string[] {
  return text
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map(item => item.trim())
    .filter(item => item !== "");
}

/** Returns the value a field's command-line text stands for. */
function fromText(key: string, text: string): unknown {
  if (key === "depends-on") return splitList(text).map(stemOf);
  if (key === "tags") return splitList(text);
  if (key === "priority") return parseNatural(text) ?? text;
  return text;
}

function repeatedKeys(yaml: string): string[] {
  const keys = yaml.split("\n").flatMap(line => /^([\w-]+):/.exec(line)?.slice(1) ?? []);
  return [...new Set(keys.filter((key, i) => keys.indexOf(key) !== i))];
}

function parseFrontmatter(yaml: string): Result<Map<string, unknown>> {
  const repeated = repeatedKeys(yaml);
  if (repeated.length > 0) return err(`repeats ${repeated.join(", ")}`);
  return map(parseYaml(yaml), value => new Map(Object.entries(value ?? {})));
}

function requiredFields(stem: string, fields: ReadonlyMap<string, unknown>, body: string): Result<Ticket> {
  const missing = REQUIRED_FIELDS.filter(key => !fields.has(key));
  if (missing.length > 0) return err(`missing ${missing.join(", ")}`);
  const createdAt = parseDate("created-at", fields.get("created-at"));
  if (!createdAt.ok) return createdAt;
  const status = parseStatus(fields.get("status"));
  if (!status.ok) return status;
  const kind = parseKind(fields.get("kind"));
  if (!kind.ok) return kind;
  const priority = parsePriority(fields.get("priority"));
  if (!priority.ok) return priority;
  const summary = parseText("summary", fields.get("summary"));
  if (!summary.ok) return summary;
  return ok({
    stem,
    createdAt: createdAt.value,
    status: status.value,
    kind: kind.value,
    priority: priority.value,
    summary: summary.value,
    dependsOn: [],
    tags: [],
    body,
  });
}

function parseTicket(stem: string, text: string): Result<Ticket> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) return err("no frontmatter");
  const body = text.slice(match[0].length);
  return andThen(parseFrontmatter(match[1]), fields => {
    const optional = [...fields].filter(([key]) => !REQUIRED_FIELDS.includes(key));
    return optional.reduce<Result<Ticket>>(
      (acc, [key, value]) => andThen(acc, ticket => withField(ticket, key, value)),
      requiredFields(stem, fields, body),
    );
  });
}

function renderFrontmatter(ticket: Ticket): string {
  const fields = {
    "created-at": ticket.createdAt,
    status: ticket.status,
    kind: ticket.kind,
    priority: ticket.priority,
    summary: ticket.summary,
    ...(ticket.branch === undefined ? {} : { branch: ticket.branch }),
    ...(ticket.closed === undefined ? {} : { closed: ticket.closed }),
    ...(ticket.dependsOn.length === 0 ? {} : { "depends-on": ticket.dependsOn }),
    ...(ticket.tags.length === 0 ? {} : { tags: ticket.tags }),
  };
  const yaml = Bun.YAML.stringify(fields, null, 2).replace(/ +$/gm, "").trimEnd();
  return `---\n${yaml}\n---\n`;
}

function render(ticket: Ticket): string {
  return renderFrontmatter(ticket) + ticket.body;
}

function find(tickets: Tickets, name: string): Result<Ticket> {
  const ticket = tickets.get(stemOf(name));
  return ticket === undefined ? err(`no ticket ${name}`) : ok(ticket);
}

function dependents(tickets: Tickets): Map<string, string[]> {
  const edges = [...tickets.values()].flatMap(ticket => ticket.dependsOn.map(dep => ({ dep, stem: ticket.stem })));
  const byDep = Map.groupBy(edges, edge => edge.dep);
  return new Map<string, string[]>([...byDep].map(([dep, group]) => [dep, group.map(edge => edge.stem)]));
}

function isReady(ticket: Ticket, tickets: Tickets): boolean {
  return !isClosed(ticket.status) && ticket.dependsOn.every(dep => tickets.get(dep)?.status === "resolved");
}

function statusOf(tickets: Tickets, stem: string): string {
  return tickets.get(stem)?.status ?? "missing";
}

function byPriority(a: Ticket, b: Ticket): number {
  return a.priority - b.priority || a.stem.localeCompare(b.stem);
}

function byClosedNewestFirst(a: Ticket, b: Ticket): number {
  return (b.closed ?? "").localeCompare(a.closed ?? "") || byPriority(a, b);
}

function titleProblems(ticket: Ticket): string[] {
  const title = titleOf(ticket);
  if (title === undefined) return ["body does not start with a # title"];
  return problemIf(
    title.startsWith("# Feature:") !== (ticket.kind === "feature"),
    `kind ${ticket.kind} disagrees with title: ${title}`,
  );
}

function dependencyProblems(ticket: Ticket, tickets: Tickets): string[] {
  return [
    ...ticket.dependsOn.flatMap(dep => [
      ...problemIf(dep === ticket.stem, "depends on itself"),
      ...problemIf(dep !== ticket.stem && !tickets.has(dep), `depends on missing ticket ${dep}`),
    ]),
    ...problemIf(new Set(ticket.dependsOn).size !== ticket.dependsOn.length, "depends-on repeats a ticket"),
  ];
}

function ticketProblems(ticket: Ticket, tickets: Tickets): string[] {
  const problems = [
    ...problemIf(ticket.summary.trim() === "", "summary is empty"),
    ...problemIf(
      ticket.branch !== undefined && ticket.status !== "in-progress",
      "branch is only for in-progress tickets",
    ),
    ...problemIf(isClosed(ticket.status) && ticket.closed === undefined, `${ticket.status} without a closed date`),
    ...problemIf(!isClosed(ticket.status) && ticket.closed !== undefined, `${ticket.status} with a closed date`),
    ...problemIf(new Set(ticket.tags).size !== ticket.tags.length, "tags repeats a tag"),
    ...titleProblems(ticket),
    ...dependencyProblems(ticket, tickets),
  ];
  return problems.map(problem => `${ticket.stem}: ${problem}`);
}

type Search = Readonly<{ done: ReadonlySet<string>; cycles: readonly string[][] }>;

/** Search depth first from `path`'s last stem, skipping stems already done. */
function searchCycles(tickets: Tickets, path: readonly string[], search: Search): Search {
  const stem = path[path.length - 1];
  const deps = (tickets.get(stem)?.dependsOn ?? []).filter(dep => dep !== stem);
  const searched = deps.reduce<Search>((acc, dep) => {
    if (path.includes(dep)) return { ...acc, cycles: [...acc.cycles, [...path.slice(path.indexOf(dep)), dep]] };
    if (acc.done.has(dep)) return acc;
    return searchCycles(tickets, [...path, dep], acc);
  }, search);
  return { ...searched, done: new Set([...searched.done, stem]) };
}

/** Rotate a cycle to start at its smallest stem. */
function canonicalCycle(cycle: readonly string[]): string {
  const nodes = cycle.slice(0, -1);
  const start = nodes.indexOf([...nodes].sort()[0]);
  const rotated = [...nodes.slice(start), ...nodes.slice(0, start)];
  return [...rotated, rotated[0]].join(" -> ");
}

function cycleProblems(tickets: Tickets, roots: Iterable<string>): string[] {
  const searched = [...roots].reduce<Search>(
    (acc, root) => (acc.done.has(root) ? acc : searchCycles(tickets, [root], acc)),
    { done: new Set(), cycles: [] },
  );
  return [...new Set(searched.cycles.map(canonicalCycle))].map(cycle => `dependency cycle: ${cycle}`);
}

const STATUS_DIR_LINK = new RegExp(`(?<![\\w/-])(?:${STATUSES.join("|")})/([\\w.-]+)\\.md`, "g");
const MARKDOWN_LINK = /\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g;

function linkTargets(text: string): string[] {
  return [...text.matchAll(MARKDOWN_LINK)].map(([, target]) => target).filter(target => !/^[a-z]+:/.test(target));
}

function linkProblems(file: string, text: string, workspace: Workspace): string[] {
  return text.split("\n").flatMap((line, i) => {
    const where = `${file}:${i + 1}`;
    const throughStatusDir = [...line.matchAll(STATUS_DIR_LINK)]
      .filter(([, stem]) => workspace.tickets.has(stem))
      .map(([link]) => `${where}: link through a status directory: ${link}`);
    const broken = linkTargets(line)
      .filter(target => !workspace.existingLinks.has(target))
      .map(target => `${where}: broken link: ${target}`);
    return [...throughStatusDir, ...broken];
  });
}

/** Split on whitespace, keeping each backtick code span in one word. */
function markdownWords(text: string): string[] {
  return text.match(/(?:(`+)[\s\S]*?(?<!`)\1(?!`)|`+|[^\s`])+/g) ?? [];
}

function wrap(prefix: string, text: string, indent: string): string {
  const lines = markdownWords(text).reduce<string[]>(
    (lines, word) => {
      const last = lines[lines.length - 1];
      const rest = lines.slice(0, -1);
      if (last === prefix) return [...rest, last + word];
      if (last.length + 1 + word.length > INDEX_WIDTH) return [...lines, indent + word];
      return [...rest, `${last} ${word}`];
    },
    [prefix],
  );
  return lines.join("\n");
}

function indexEntry(ticket: Ticket): string {
  const branch = ticket.branch === undefined ? "" : ` On \`${ticket.branch}\`.`;
  return wrap("- ", `[\`${fileOf(ticket.stem)}\`](${fileOf(ticket.stem)}): ${ticket.summary}${branch}`, "  ");
}

function renderIndex(tickets: Tickets): string {
  const sections = STATUSES.map(status => {
    const order = isClosed(status) ? byClosedNewestFirst : byPriority;
    const group = [...tickets.values()].filter(ticket => ticket.status === status).sort(order);
    const entries = group.length === 0 ? "None." : group.map(indexEntry).join("\n");
    return `### ${STATUS_HEADINGS[status]}\n\n${entries}`;
  });
  return sections.join("\n\n");
}

function withIndex(readme: string, tickets: Tickets): Result<string> {
  const begin = readme.indexOf(INDEX_BEGIN);
  const end = readme.indexOf(INDEX_END);
  if (begin < 0 || end < begin) return err(`README.md lacks ${INDEX_BEGIN} and ${INDEX_END}`);
  const before = readme.slice(0, begin + INDEX_BEGIN.length);
  const after = readme.slice(end);
  return ok(`${before}\n\n${renderIndex(tickets)}\n\n${after}`);
}

function readmeOf(workspace: Workspace): string {
  return workspace.files.get(README) ?? "";
}

/** Validate `ticket` against the others, and write it with the regenerated README index. */
function persist(ticket: Ticket, tickets: Tickets, workspace: Workspace, stdout?: string): Result<Outcome, Failure> {
  const updated = new Map(tickets).set(ticket.stem, ticket);
  const problems = [...ticketProblems(ticket, updated), ...cycleProblems(updated, [ticket.stem])];
  if (problems.length > 0) return usage(err(problems.join("\n")));
  return map(invalid(withIndex(readmeOf(workspace), updated)), readme => ({
    stdout,
    writes: new Map([
      [fileOf(ticket.stem), render(ticket)],
      [README, readme],
    ]),
  }));
}

function table(rows: readonly string[][]): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
  const lines = rows.map(row => {
    const padded = row.slice(0, -1).map((cell, column) => cell.padEnd(widths[column]));
    return [...padded, ...row.slice(-1)].join("  ");
  });
  return lines.join("\n");
}

type ListRequest = Readonly<{
  statuses: readonly Status[];
  kinds: readonly Kind[];
  branch?: string;
  tags?: readonly string[];
  ready: boolean;
}>;

function parseStatusFilter(names: readonly string[]): Result<readonly Status[]> {
  const split = names.flatMap(splitList);
  return split.includes("all") ? ok(STATUSES) : all(split.map(parseStatus));
}

function parseListArgs(args: string[]): Result<ListRequest> {
  const parsed = parseArgsSafely(() =>
    parseArgs({
      args,
      options: {
        status: { type: "string", multiple: true, default: ["open", "in-progress"] },
        kind: { type: "string", multiple: true, default: [...KINDS] },
        branch: { type: "string" },
        tag: { type: "string", multiple: true },
        ready: { type: "boolean", default: false },
      },
    }),
  );
  if (!parsed.ok) return parsed;
  const { values } = parsed.value;
  const statuses = parseStatusFilter(values.status);
  if (!statuses.ok) return statuses;
  return map(all(values.kind.flatMap(splitList).map(parseKind)), kinds => ({
    statuses: statuses.value,
    kinds,
    branch: values.branch,
    tags: values.tag?.flatMap(splitList),
    ready: values.ready,
  }));
}

function listTickets(request: ListRequest, tickets: Tickets): Outcome {
  const shown = [...tickets.values()]
    .filter(ticket => request.statuses.includes(ticket.status) && request.kinds.includes(ticket.kind))
    .filter(ticket => request.branch === undefined || ticket.branch === request.branch)
    .filter(ticket => request.tags === undefined || request.tags.some(tag => ticket.tags.includes(tag)))
    .filter(ticket => !request.ready || isReady(ticket, tickets))
    .sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || byPriority(a, b));
  if (shown.length === 0) return {};
  return { stdout: table(shown.map(t => [String(t.priority), t.status, t.stem, t.summary])) };
}

const listCommand: TicketCommand = (args, tickets) =>
  map(usage(parseListArgs(args)), request => listTickets(request, tickets));

function parseShowArgs(args: string[], tickets: Tickets): Result<Ticket> {
  return andThen(parseArgsSafely(() => parseArgs({ args, allowPositionals: true })), ({ positionals }) =>
    positionals.length === 1 ? find(tickets, positionals[0]) : err(USAGE.show),
  );
}

function lastDatedSection(ticket: Ticket): string {
  const sections = ticket.body.split(/\n(?=## )/).filter(section => section.startsWith("## "));
  const dated = sections.filter(section => /^## \d{4}-\d{2}-\d{2}/.test(section));
  return (dated.at(-1) ?? sections[0] ?? "").trimEnd();
}

function relatedLines(heading: string, stems: readonly string[], tickets: Tickets): string[] {
  if (stems.length === 0) return [`${heading}: none`];
  return [`${heading}:`, ...stems.map(stem => `  ${stem} (${statusOf(tickets, stem)})`)];
}

function showTicket(ticket: Ticket, tickets: Tickets): Outcome {
  const lines = [
    renderFrontmatter(ticket).trimEnd(),
    "",
    titleOf(ticket) ?? ticket.stem,
    "",
    ...relatedLines("depends on", ticket.dependsOn, tickets),
    ...relatedLines("needed by", dependents(tickets).get(ticket.stem) ?? [], tickets),
    "",
    lastDatedSection(ticket),
  ];
  return { stdout: lines.join("\n") };
}

const showCommand: TicketCommand = (args, tickets) =>
  map(usage(parseShowArgs(args, tickets)), ticket => showTicket(ticket, tickets));

type DepsRequest = Readonly<{ root: Ticket; reverse: boolean; maxDepth: number }>;

function parseDepth(text: string | undefined): Result<number> {
  if (text === undefined) return ok(Number.POSITIVE_INFINITY);
  const depth = parseNatural(text);
  return depth === undefined ? err(`--depth is not a non-negative integer: ${text}`) : ok(depth);
}

function parseDepsArgs(args: string[], tickets: Tickets): Result<DepsRequest> {
  const parsed = parseArgsSafely(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: { reverse: { type: "boolean", default: false }, depth: { type: "string" } },
    }),
  );
  if (!parsed.ok) return parsed;
  const { values, positionals } = parsed.value;
  if (positionals.length !== 1) return err(USAGE.deps);
  const maxDepth = parseDepth(values.depth);
  if (!maxDepth.ok) return maxDepth;
  return map(find(tickets, positionals[0]), root => ({ root, reverse: values.reverse, maxDepth: maxDepth.value }));
}

type Tree = Readonly<{
  children: (stem: string) => readonly string[];
  label: (stem: string) => string;
  maxDepth: number;
}>;

/** Returns the lines under `ancestors`' last stem, drawn with box characters. */
function treeLines(tree: Tree, ancestors: readonly string[], prefix: string): string[] {
  if (ancestors.length > tree.maxDepth) return [];
  const children = tree.children(ancestors[ancestors.length - 1]);
  return children.flatMap((child, i) => {
    const last = i === children.length - 1;
    const line = `${prefix}${last ? "└── " : "├── "}${tree.label(child)}`;
    if (ancestors.includes(child)) return [`${line} (cycle)`];
    return [line, ...treeLines(tree, [...ancestors, child], prefix + (last ? "    " : "│   "))];
  });
}

function dependencyTree(request: DepsRequest, tickets: Tickets): Outcome {
  const reverse = dependents(tickets);
  const tree: Tree = {
    children: stem => [...((request.reverse ? reverse.get(stem) : tickets.get(stem)?.dependsOn) ?? [])].sort(),
    label: stem => `${stem} (${statusOf(tickets, stem)})`,
    maxDepth: request.maxDepth,
  };
  return { stdout: [tree.label(request.root.stem), ...treeLines(tree, [request.root.stem], "")].join("\n") };
}

const depsCommand: TicketCommand = (args, tickets) =>
  map(usage(parseDepsArgs(args, tickets)), request => dependencyTree(request, tickets));

type NewRequest = Readonly<{ stem: string; kind: Kind; priority: number; summary: string; title: string }>;

function nextPriority(tickets: Tickets): number {
  const open = [...tickets.values()].filter(ticket => !isClosed(ticket.status));
  return Math.max(0, ...open.map(ticket => ticket.priority)) + 10;
}

function parseNewStem(name: string, tickets: Tickets): Result<string> {
  const stem = stemOf(name);
  if (!KEBAB_CASE.test(stem)) return err(`stem is not kebab-case: ${stem}`);
  if (tickets.has(stem)) return err(`${stem} already exists`);
  return ok(stem);
}

function parseNewArgs(args: string[], tickets: Tickets): Result<NewRequest> {
  const parsed = parseArgsSafely(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: {
        summary: { type: "string" },
        kind: { type: "string", default: "bug" },
        priority: { type: "string" },
        title: { type: "string" },
      },
    }),
  );
  if (!parsed.ok) return parsed;
  const { values, positionals } = parsed.value;
  const summary = values.summary;
  if (positionals.length !== 1 || summary === undefined) return err(USAGE.new);
  const stem = parseNewStem(positionals[0], tickets);
  if (!stem.ok) return stem;
  const kind = parseKind(values.kind);
  if (!kind.ok) return kind;
  const priority =
    values.priority === undefined ? ok(nextPriority(tickets)) : parsePriority(fromText("priority", values.priority));
  if (!priority.ok) return priority;
  const title = values.title ?? stem.value.replaceAll("-", " ").replace(/^./, first => first.toUpperCase());
  return ok({ stem: stem.value, kind: kind.value, priority: priority.value, summary, title });
}

function skeleton(kind: Kind, title: string): string {
  if (kind === "feature") {
    return `\n# Feature: ${title}\n\n## Request\n\n## Proposal\n\n## Open questions\n`;
  }
  return `\n# ${title}\n\n## Report\n`;
}

const newCommand: TicketCommand = (args, tickets, workspace) =>
  andThen(usage(parseNewArgs(args, tickets)), ({ stem, kind, priority, summary, title }) =>
    persist(
      {
        stem,
        createdAt: workspace.today,
        status: "open",
        kind,
        priority,
        summary,
        dependsOn: [],
        tags: [],
        body: skeleton(kind, title),
      },
      tickets,
      workspace,
      join(workspace.dir, fileOf(stem)),
    ),
  );

type CloseRequest = Readonly<{ ticket: Ticket; status: "resolved" | "wontfix" }>;

function parseCloseArgs(args: string[], tickets: Tickets): Result<CloseRequest> {
  const parsed = parseArgsSafely(() => parseArgs({ args, allowPositionals: true }));
  if (!parsed.ok) return parsed;
  const [name, status] = parsed.value.positionals;
  if (parsed.value.positionals.length !== 2 || (status !== "resolved" && status !== "wontfix")) {
    return err(USAGE.close);
  }
  return andThen(find(tickets, name), ticket =>
    isClosed(ticket.status) ? err(`${ticket.stem} is already ${ticket.status}`) : ok({ ticket, status }),
  );
}

function closedTicket({ ticket, status }: CloseRequest, today: string): Ticket {
  return {
    ...ticket,
    status,
    closed: today,
    branch: undefined,
    body: `${ticket.body.trimEnd()}\n\n## ${today}: ${status}\n`,
  };
}

const closeCommand: TicketCommand = (args, tickets, workspace) =>
  andThen(usage(parseCloseArgs(args, tickets)), request =>
    persist(closedTicket(request, workspace.today), tickets, workspace, join(workspace.dir, fileOf(request.ticket.stem))),
  );

function parseAssignment(assignment: string): Result<[string, string]> {
  const eq = assignment.indexOf("=");
  if (eq < 0) return err(`not key=value: ${assignment}`);
  return ok([assignment.slice(0, eq), assignment.slice(eq + 1)]);
}

function assign(ticket: Ticket, [key, text]: [string, string]): Result<Ticket> {
  return text === "" ? withoutField(ticket, key) : withField(ticket, key, fromText(key, text));
}

/** Returns the ticket `set` names, with its assignments applied. */
function parseSetArgs(args: string[], tickets: Tickets): Result<Ticket> {
  const parsed = parseArgsSafely(() => parseArgs({ args, allowPositionals: true }));
  if (!parsed.ok) return parsed;
  const [name, ...assignments] = parsed.value.positionals;
  if (name === undefined || assignments.length === 0) return err(USAGE.set);
  const ticket = find(tickets, name);
  if (!ticket.ok) return ticket;
  return andThen(all(assignments.map(parseAssignment)), pairs =>
    pairs.reduce<Result<Ticket>>((acc, pair) => andThen(acc, current => assign(current, pair)), ticket),
  );
}

const setCommand: TicketCommand = (args, tickets, workspace) =>
  andThen(usage(parseSetArgs(args, tickets)), ticket => persist(ticket, tickets, workspace));

const indexCommand: TicketCommand = (args, tickets, workspace) =>
  andThen(usage(parseArgsSafely(() => parseArgs({ args }))), () =>
    map(invalid(withIndex(readmeOf(workspace), tickets)), readme => ({ writes: new Map([[README, readme]]) })),
  );

function workspaceProblems(workspace: Workspace): string[] {
  const { tickets, parseErrors, files } = workspace;
  const readme = readmeOf(workspace);
  const indexed = withIndex(readme, tickets);
  const indexProblems = indexed.ok
    ? problemIf(parseErrors.length === 0 && indexed.value !== readme, "README.md: index is stale; run tix index")
    : [indexed.error];
  return [
    ...parseErrors,
    ...[...tickets.values()].flatMap(ticket => ticketProblems(ticket, tickets)),
    ...[...files].flatMap(([file, text]) => linkProblems(file, text, workspace)),
    ...cycleProblems(tickets, tickets.keys()),
    ...indexProblems,
  ];
}

const checkCommand: Command = (args, workspace) =>
  map(usage(parseArgsSafely(() => parseArgs({ args }))), () => {
    const problems = workspaceProblems(workspace);
    return problems.length === 0 ? {} : { stderr: problems.join("\n"), exitCode: 1 };
  });

/** Run `command` only when every ticket parses. */
function withTickets(command: TicketCommand): Command {
  return (args, workspace) => {
    if (workspace.parseErrors.length > 0) return invalid(err(workspace.parseErrors.join("\n")));
    return command(args, workspace.tickets, workspace);
  };
}

const HELP = `usage: tix [-C dir] <command> [args]

  -C dir                 the tickets' directory (default: .); repeats resolve
                         against the one before

  list [--status s,...|all] [--kind k] [--branch b] [--tag t,...] [--ready]
                         open and in-progress tickets by priority, or those given;
                         --tag keeps tickets with any of the tags
  show <stem>            frontmatter, dependencies both ways, last dated section
  deps <stem> [--reverse] [--depth n]
                         tree of what <stem> depends on; --reverse, what depends on it
  new <stem> --summary s [--kind bug|feature] [--priority n] [--title t]
  close <stem> resolved|wontfix
  set <stem> key=value ...
                         an empty value removes the field; depends-on and tags take a,b
  index                  regenerate the README index
  check                  validate every ticket, link and the README index

new, close and set regenerate the README index.
Exits 1 on tickets that are already broken, 2 on a bad request.`;

const COMMANDS: Record<string, Command> = {
  list: withTickets(listCommand),
  show: withTickets(showCommand),
  deps: withTickets(depsCommand),
  new: withTickets(newCommand),
  close: withTickets(closeCommand),
  set: withTickets(setCommand),
  index: withTickets(indexCommand),
  check: checkCommand,
};

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

async function existingTargets(dir: string, files: ReadonlyMap<string, string>): Promise<Set<string>> {
  const targets = [...new Set([...files.values()].flatMap(linkTargets))];
  const found = await Promise.all(
    targets.map(async target => ((await Bun.file(join(dir, target)).exists()) ? [target] : [])),
  );
  return new Set(found.flat());
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(s => s.isDirectory(), () => false);
}

async function loadWorkspace(dir: string, withLinks: boolean): Promise<Workspace> {
  const names = (await Array.fromAsync(new Bun.Glob("*.md").scan(dir))).sort();
  const texts = await Promise.all(names.map(name => Bun.file(join(dir, name)).text()));
  const files = new Map<string, string>(names.map((name, i) => [name, texts[i]]));
  const parsed = [...files]
    .filter(([name]) => name !== README)
    .map(([name, text]) => ({ stem: stemOf(name), result: parseTicket(stemOf(name), text) }));

  return {
    dir,
    tickets: new Map<string, Ticket>(parsed.flatMap(({ stem, result }) => (result.ok ? [[stem, result.value]] : []))),
    parseErrors: parsed.flatMap(({ stem, result }) => (result.ok ? [] : [`${stem}: ${result.error}`])),
    files,
    existingLinks: withLinks ? await existingTargets(dir, files) : new Set(),
    today: today(),
  };
}

async function perform(dir: string, outcome: Outcome): Promise<void> {
  await Promise.all([...(outcome.writes ?? [])].map(([file, text]) => Bun.write(join(dir, file), text)));
  if (outcome.stdout !== undefined) console.log(outcome.stdout);
  if (outcome.stderr !== undefined) console.error(outcome.stderr);
  if (outcome.exitCode !== undefined) process.exitCode = outcome.exitCode;
}

async function main(dir: string, argv: string[]): Promise<Outcome> {
  const [name, ...args] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") return { stdout: HELP };
  const command = COMMANDS[name];
  if (command === undefined) return { stderr: `tix: unknown command ${name}\n\n${HELP}`, exitCode: 2 };
  if (!(await isDirectory(dir))) return { stderr: `tix: ${dir} is not a directory`, exitCode: 2 };
  const result = command(args, await loadWorkspace(dir, name === "check"));
  return result.ok ? result.value : { stderr: `tix: ${result.error.message}`, exitCode: result.error.exitCode };
}

/** Each `-C` resolves against the one before it. */
function splitDir(argv: string[], dir = "."): Result<[string, string[]]> {
  if (argv[0] !== "-C") return ok([dir, argv]);
  if (argv[1] === undefined) return err(`tix: -C needs a directory\n\n${HELP}`);
  return splitDir(argv.slice(2), resolve(dir, argv[1]));
}

const split = splitDir(process.argv.slice(2));
if (split.ok) await perform(split.value[0], await main(...split.value));
else await perform(".", { stderr: split.error, exitCode: 2 });
