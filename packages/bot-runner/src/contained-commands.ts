import { statSync } from "node:fs";
import { unproven } from "./contained-lex.js";
import { atLeast, atMost, getopt, has, type OptionTable, type Options, type Prover } from "./contained-prover.js";

interface CommandSpec {
  readonly options: OptionTable;
  readonly operands: (options: Options, prover: Prover) => void;
  /** 会建出符号链接。之后的段按判定时的样子解路径就不准了，所以只许放在最后一段。 */
  readonly makesLinks?: (options: Options) => boolean;
}

const paths = (options: Options, prover: Prover): void => prover.paths(options.operands);
const noOperands = (options: Options): void => atMost(options, 0);

/** 解包时成员名只用来挑归档里的条目，不许看起来要往外走。 */
const memberName = (word: string): void => {
  if (word.startsWith("/") || word.split("/").includes("..")) unproven(`成员名往外走：${word}`);
};

const COMPRESS: CommandSpec = {
  options: {
    flags: "dvqtlnNkcz0123456789",
    long: {
      keep: "flag",
      stdout: "flag",
      "to-stdout": "flag",
      decompress: "flag",
      uncompress: "flag",
      verbose: "flag",
      quiet: "flag",
      test: "flag",
      list: "flag",
      name: "flag",
      "no-name": "flag",
      best: "flag",
      fast: "flag",
    },
  },
  operands: (options, prover) => {
    // 不带 -k 或 -c 时压完会删掉原文件。
    if (!has(options, "k", "c", "--keep", "--stdout", "--to-stdout")) unproven("压缩不带 -k 或 -c 会删原文件");
    paths(options, prover);
  },
};

const HEAD_TAIL: CommandSpec = {
  options: {
    flags: "qvz",
    values: { n: "number", c: "number" },
    long: {
      lines: "number",
      bytes: "number",
      quiet: "flag",
      silent: "flag",
      verbose: "flag",
      "zero-terminated": "flag",
    },
    digits: true,
  },
  operands: paths,
};

// awk 程序里能跑命令、读别的文件、碰环境的写法。比较用的 > 也一并不认，宁可多问。
const AWK_FORBIDDEN = /system|getline|[|>@]|ENVIRON|ARGV|ARGC|PROCINFO/;
const AWK_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// jq 能读模块文件、环境和程序位置的内建。
const JQ_FORBIDDEN =
  /\b(?:import|include|env|modulemeta|get_search_list|get_prog_origin|get_jq_origin|input_filename)\b|\$ENV|\$__prog/;

const CHMOD_MODE = /^(?:0?[0-7]{1,3}|[ugoa]*[-+=][rwxX]*(?:,[ugoa]*[-+=][rwxX]*)*)$/;
const SLEEP_DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
const BARE_NAME = /^[A-Za-z0-9._+-]+$/;

const SPECS: Readonly<Record<string, CommandSpec>> = {
  ls: {
    options: {
      flags: "aAbBcCdfFgGhiklmnNopqQrRsStuUvxXZ1",
      long: {
        all: "flag",
        "almost-all": "flag",
        "human-readable": "flag",
        recursive: "flag",
        reverse: "flag",
        directory: "flag",
        classify: "flag",
        color: "optional",
        "group-directories-first": "flag",
        "full-time": "flag",
        inode: "flag",
        size: "flag",
        sort: "text",
        time: "text",
        "time-style": "text",
      },
    },
    operands: paths,
  },
  cat: {
    options: {
      flags: "AbeEnstTuv",
      long: {
        number: "flag",
        "number-nonblank": "flag",
        "squeeze-blank": "flag",
        "show-ends": "flag",
        "show-tabs": "flag",
        "show-nonprinting": "flag",
        "show-all": "flag",
      },
    },
    operands: paths,
  },
  head: HEAD_TAIL,
  tail: HEAD_TAIL,
  wc: {
    options: {
      flags: "lwcmL",
      long: { lines: "flag", words: "flag", bytes: "flag", chars: "flag", "max-line-length": "flag" },
    },
    operands: paths,
  },
  stat: {
    options: {
      flags: "Lft",
      values: { c: "text" },
      long: { format: "text", printf: "text", dereference: "flag", "file-system": "flag", terse: "flag" },
    },
    operands: paths,
  },
  file: {
    options: {
      flags: "bihLzk",
      long: {
        brief: "flag",
        mime: "flag",
        "mime-type": "flag",
        "mime-encoding": "flag",
        dereference: "flag",
        "no-dereference": "flag",
        uncompress: "flag",
        "keep-going": "flag",
      },
    },
    operands: paths,
  },
  du: {
    options: {
      flags: "abchkmsx",
      values: { d: "number" },
      long: {
        "max-depth": "number",
        summarize: "flag",
        "human-readable": "flag",
        all: "flag",
        "apparent-size": "flag",
        total: "flag",
      },
    },
    operands: paths,
  },
  grep: {
    options: {
      flags: "iynvrEFGPwxlLcqsoHhbaIUzZ",
      values: { e: "text", f: "path", m: "number", A: "number", B: "number", C: "number" },
      long: {
        "ignore-case": "flag",
        "line-number": "flag",
        "invert-match": "flag",
        recursive: "flag",
        "extended-regexp": "flag",
        "fixed-strings": "flag",
        "basic-regexp": "flag",
        "perl-regexp": "flag",
        "word-regexp": "flag",
        "line-regexp": "flag",
        "files-with-matches": "flag",
        "files-without-match": "flag",
        count: "flag",
        quiet: "flag",
        silent: "flag",
        "no-messages": "flag",
        "only-matching": "flag",
        "with-filename": "flag",
        "no-filename": "flag",
        "byte-offset": "flag",
        text: "flag",
        null: "flag",
        "null-data": "flag",
        color: "optional",
        colour: "optional",
        include: "text",
        exclude: "text",
        "exclude-dir": "text",
        "max-count": "number",
        "after-context": "number",
        "before-context": "number",
        context: "number",
        regexp: "text",
        file: "path",
      },
    },
    operands: (options, prover) => {
      const patternGiven = has(options, "e", "f", "--regexp", "--file");
      if (!patternGiven && options.operands.length === 0) unproven("grep 没有模式");
      prover.paths(patternGiven ? options.operands : options.operands.slice(1));
    },
  },
  sort: {
    options: {
      flags: "bdfghiMnrRsuVzcCm",
      values: { k: "text", t: "text", S: "text", o: "path", T: "path" },
      long: {
        "numeric-sort": "flag",
        "general-numeric-sort": "flag",
        "human-numeric-sort": "flag",
        "version-sort": "flag",
        "month-sort": "flag",
        reverse: "flag",
        unique: "flag",
        stable: "flag",
        "ignore-case": "flag",
        "ignore-leading-blanks": "flag",
        "dictionary-order": "flag",
        "ignore-nonprinting": "flag",
        merge: "flag",
        "zero-terminated": "flag",
        key: "text",
        "field-separator": "text",
        "buffer-size": "text",
        sort: "text",
        parallel: "number",
        output: "path",
        "temporary-directory": "path",
      },
    },
    operands: paths,
  },
  uniq: {
    options: {
      flags: "cdDiuz",
      values: { f: "number", s: "number", w: "number" },
      long: {
        count: "flag",
        repeated: "flag",
        unique: "flag",
        "ignore-case": "flag",
        "zero-terminated": "flag",
        "skip-fields": "number",
        "skip-chars": "number",
        "check-chars": "number",
      },
    },
    operands: (options, prover) => {
      atMost(options, 2);
      paths(options, prover);
    },
  },
  cut: {
    options: {
      flags: "snz",
      values: { b: "text", c: "text", f: "text", d: "text" },
      long: {
        bytes: "text",
        characters: "text",
        fields: "text",
        delimiter: "text",
        "only-delimited": "flag",
        complement: "flag",
        "output-delimiter": "text",
        "zero-terminated": "flag",
      },
    },
    operands: paths,
  },
  tr: {
    options: {
      flags: "cCdst",
      long: { complement: "flag", delete: "flag", "squeeze-repeats": "flag", "truncate-set1": "flag" },
    },
    operands: () => {},
  },
  nl: {
    options: {
      flags: "p",
      values: {
        b: "text",
        d: "text",
        f: "text",
        h: "text",
        i: "text",
        l: "text",
        n: "text",
        s: "text",
        v: "text",
        w: "text",
      },
    },
    operands: paths,
  },
  diff: {
    options: {
      flags: "qsuciwbBaNy",
      values: { U: "number", C: "number" },
      long: {
        brief: "flag",
        "report-identical-files": "flag",
        unified: "optional",
        context: "optional",
        "ignore-case": "flag",
        "ignore-all-space": "flag",
        "ignore-space-change": "flag",
        "ignore-blank-lines": "flag",
        text: "flag",
        "new-file": "flag",
        "side-by-side": "flag",
        color: "optional",
      },
    },
    operands: (options, prover) => {
      if (options.operands.length !== 2) unproven("diff 只比两个文件");
      paths(options, prover);
      // 两边有一个是目录时 diff 会去读目录里的条目，那些条目可能是指向外面的链接。
      for (const word of options.operands) {
        if (word !== "-" && statSync(prover.resolve(word), { throwIfNoEntry: false })?.isDirectory() === true) {
          unproven(`diff 的参数是目录：${word}`);
        }
      }
    },
  },
  cmp: {
    options: { flags: "bls", long: { "print-bytes": "flag", verbose: "flag", quiet: "flag", silent: "flag" } },
    operands: (options, prover) => {
      atMost(options, 2);
      paths(options, prover);
    },
  },
  comm: {
    options: {
      flags: "123z",
      long: {
        "check-order": "flag",
        "nocheck-order": "flag",
        "output-delimiter": "text",
        total: "flag",
        "zero-terminated": "flag",
      },
    },
    operands: (options, prover) => {
      if (options.operands.length !== 2) unproven("comm 只比两个文件");
      paths(options, prover);
    },
  },
  jq: {
    options: {
      flags: "rjcnsaSCMeR",
      long: {
        "raw-output": "flag",
        "join-output": "flag",
        "ascii-output": "flag",
        "compact-output": "flag",
        "null-input": "flag",
        slurp: "flag",
        "color-output": "flag",
        "monochrome-output": "flag",
        "sort-keys": "flag",
        "exit-status": "flag",
        "raw-input": "flag",
        tab: "flag",
        indent: "number",
        arg: "pair",
        argjson: "pair",
      },
    },
    operands: (options, prover) => {
      const [filter, ...files] = options.operands;
      if (filter !== undefined && JQ_FORBIDDEN.test(filter)) unproven("jq 程序读模块、环境或文件");
      prover.paths(files);
    },
  },
  pwd: { options: { flags: "LP" }, operands: noOperands },
  date: {
    options: {
      flags: "uR",
      values: { d: "text", r: "path" },
      long: {
        date: "text",
        reference: "path",
        "iso-8601": "optional",
        "rfc-3339": "text",
        "rfc-email": "flag",
        utc: "flag",
        universal: "flag",
      },
    },
    operands: (options) => {
      atMost(options, 1);
      const format = options.operands[0];
      if (format !== undefined && !format.startsWith("+")) unproven("date 的参数不是 + 开头的格式，会去改系统时间");
    },
  },
  whoami: { options: {}, operands: noOperands },
  id: { options: { flags: "ugGnrz" }, operands: (options) => atMost(options, 1) },
  uname: {
    options: {
      flags: "asnrvmpio",
      long: {
        all: "flag",
        "kernel-name": "flag",
        nodename: "flag",
        "kernel-release": "flag",
        "kernel-version": "flag",
        machine: "flag",
        processor: "flag",
        "hardware-platform": "flag",
        "operating-system": "flag",
      },
    },
    operands: noOperands,
  },
  df: {
    options: {
      flags: "ahHiklPT",
      values: { t: "text", x: "text" },
      long: {
        output: "optional",
        all: "flag",
        "human-readable": "flag",
        si: "flag",
        inodes: "flag",
        local: "flag",
        portability: "flag",
        "print-type": "flag",
        total: "flag",
        type: "text",
        "exclude-type": "text",
      },
    },
    operands: paths,
  },
  free: {
    options: {
      flags: "bkmghtwl",
      long: {
        bytes: "flag",
        kibi: "flag",
        mebi: "flag",
        gibi: "flag",
        human: "flag",
        wide: "flag",
        total: "flag",
        lohi: "flag",
      },
    },
    operands: noOperands,
  },
  uptime: { options: { flags: "ps", long: { pretty: "flag", since: "flag" } }, operands: noOperands },
  nproc: { options: { long: { all: "flag", ignore: "number" } }, operands: noOperands },
  hostname: {
    options: {
      flags: "sfdiIA",
      long: {
        short: "flag",
        fqdn: "flag",
        domain: "flag",
        "ip-address": "flag",
        "all-ip-addresses": "flag",
        "all-fqdns": "flag",
      },
    },
    operands: noOperands,
  },
  sleep: {
    options: {},
    operands: (options) => {
      atLeast(options, 1);
      if (!options.operands.every((word) => SLEEP_DURATION.test(word))) unproven("sleep 的时长认不出");
    },
  },
  which: {
    options: { flags: "as" },
    operands: (options) => {
      if (!options.operands.every((word) => BARE_NAME.test(word))) unproven("which 只查裸命令名");
    },
  },
  mkdir: {
    options: { flags: "pv", values: { m: "text" }, long: { parents: "flag", verbose: "flag", mode: "text" } },
    operands: (options, prover) => {
      atLeast(options, 1);
      paths(options, prover);
    },
  },
  touch: {
    options: {
      flags: "acm",
      values: { d: "text", t: "text", r: "path" },
      long: { "no-create": "flag", date: "text", time: "text", reference: "path" },
    },
    operands: (options, prover) => {
      atLeast(options, 1);
      paths(options, prover);
    },
  },
  cp: {
    options: {
      flags: "rRpvnua",
      long: { recursive: "flag", verbose: "flag", "no-clobber": "flag", archive: "flag", update: "optional" },
    },
    operands: (options, prover) => {
      atLeast(options, 2);
      paths(options, prover);
    },
    // cp -r 照原样拷链接，拷进来的链接可以指向外面。
    makesLinks: () => true,
  },
  tee: {
    options: {
      flags: "aip",
      long: { append: "flag", "ignore-interrupts": "flag", "output-error": "optional" },
    },
    operands: paths,
  },
  chmod: {
    options: {
      flags: "Rvcf",
      long: { recursive: "flag", verbose: "flag", changes: "flag", silent: "flag", quiet: "flag" },
    },
    operands: (options, prover) => {
      const [mode, ...files] = options.operands;
      if (mode === undefined || !CHMOD_MODE.test(mode)) unproven("chmod 的模式认不出，或带 setuid、粘滞位");
      if (files.length === 0) unproven("chmod 没有文件");
      prover.paths(files);
    },
  },
  sed: {
    options: {
      flags: "nErsuz",
      values: { e: "text", l: "number", i: "optional" },
      long: {
        quiet: "flag",
        silent: "flag",
        "regexp-extended": "flag",
        separate: "flag",
        unbuffered: "flag",
        "null-data": "flag",
        posix: "flag",
        sandbox: "flag",
        expression: "text",
        "line-length": "number",
        "in-place": "optional",
      },
    },
    operands: (options, prover) => {
      if (options.values.has("i") || options.values.has("--in-place")) unproven("sed -i 带备份后缀");
      const expressions = [...(options.values.get("e") ?? []), ...(options.values.get("--expression") ?? [])];
      const [first, ...rest] = options.operands;
      const scripts = expressions.length > 0 ? expressions : first === undefined ? [] : [first];
      if (scripts.length === 0) unproven("sed 没有脚本");
      for (const script of scripts) sedScript(script);
      prover.paths(expressions.length > 0 ? options.operands : rest);
    },
  },
  awk: {
    options: { values: { F: "text", v: "text" }, stopAtOperand: true },
    operands: (options, prover) => {
      const [program, ...rest] = options.operands;
      if (program === undefined) return unproven("awk 没有程序");
      const assignments = [...(options.values.get("v") ?? []), program];
      for (const word of rest) {
        if (AWK_ASSIGNMENT.test(word)) assignments.push(word);
        else prover.path(word);
      }
      if (assignments.some((text) => AWK_FORBIDDEN.test(text))) unproven("awk 程序会跑命令、读别的文件或碰环境");
    },
  },
  gzip: COMPRESS,
  gunzip: COMPRESS,
  bzip2: COMPRESS,
  xz: COMPRESS,
  unzip: {
    options: { flags: "ltqnojvp", values: { d: "path" }, noDoubleDash: true },
    operands: (options, prover) => {
      const [archive, ...members] = options.operands;
      if (archive === undefined) return unproven("unzip 没有归档");
      prover.path(archive);
      members.forEach(memberName);
    },
    makesLinks: () => true,
  },
  zip: {
    options: { flags: "qv0123456789jDXry", noDoubleDash: true },
    operands: (options, prover) => {
      // 不带 -y 时 -r 会跟着链接把外面的文件打进来。
      if (has(options, "r") && !has(options, "y")) unproven("zip -r 不带 -y 会跟随链接");
      atLeast(options, 1);
      paths(options, prover);
    },
  },
};

/** echo 这几个是 bash 内建，不拆选项，参数全是文本。 */
const TEXT_COMMANDS: ReadonlySet<string> = new Set(["echo", "printf", "true", "false"]);

function sedScript(script: string): void {
  let index = 0;
  const at = (): string | undefined => script[index];
  const spaces = (): void => {
    while (at() === " " || at() === "\t") index += 1;
  };
  const digits = (): boolean => {
    const start = index;
    while (/^\d$/.test(at() ?? "")) index += 1;
    return index > start;
  };
  // GNU sed 的 match_slash 也是这样找：反斜杠吃掉下一个字符，之后第一个分隔符收尾，方括号不特殊对待。
  const delimited = (delimiter: string): void => {
    for (;;) {
      const char = at();
      if (char === undefined) unproven("sed 的正则或替换没闭合");
      index += 1;
      if (char === "\\") {
        if (at() === undefined) unproven("sed 的正则以反斜杠结尾");
        index += 1;
      } else if (char === delimiter) {
        return;
      }
    }
  };
  const address = (second: boolean): boolean => {
    const char = at();
    if (char === "$") {
      index += 1;
      return true;
    }
    if (char === "/") {
      index += 1;
      delimited("/");
      return true;
    }
    if (second && (char === "+" || char === "~")) {
      index += 1;
      if (!digits()) unproven("sed 的地址步长缺数字");
      return true;
    }
    return digits();
  };
  for (;;) {
    spaces();
    if (at() === undefined) return;
    if (at() === ";") {
      index += 1;
      continue;
    }
    if (address(false)) {
      spaces();
      if (at() === ",") {
        index += 1;
        spaces();
        if (!address(true)) unproven("sed 的第二个地址认不出");
      }
    }
    spaces();
    if (at() === "!") {
      index += 1;
      spaces();
    }
    const command = at();
    index += 1;
    if (command === "q") {
      digits();
    } else if (command === "s") {
      const delimiter = at();
      if (delimiter === undefined || delimiter === "\\") unproven("sed s 的分隔符认不出");
      index += 1;
      delimited(delimiter ?? "");
      delimited(delimiter ?? "");
      while (/^[gpiImM0-9]$/.test(at() ?? "")) index += 1;
    } else if (command !== "p" && command !== "d") {
      unproven(`sed 命令 ${command ?? ""} 不认`);
    }
    spaces();
    if (at() === undefined) return;
    if (at() !== ";") unproven("sed 命令后面只能接分号");
    index += 1;
  }
}

const TAR_LETTERS = new Set("cxtzjJvfCO");
const TAR_LONG = new Set(["--gzip", "--bzip2", "--xz", "--verbose"]);

function tarCheck(words: readonly string[], prover: Prover): { readonly extracts: boolean } {
  let mode: string | null = null;
  let archive: string | null = null;
  const dirs: string[] = [];
  const members: string[] = [];
  const letter = (char: string): void => {
    if (!TAR_LETTERS.has(char)) unproven(`tar 选项 ${char} 不认`);
    if (char === "c" || char === "x" || char === "t") {
      if (mode !== null && mode !== char) unproven("tar 只能有一种模式");
      mode = char;
    }
  };
  const value = (char: string, given: string): void => {
    if (char === "C") dirs.push(given);
    else if (archive === null) archive = given;
    else unproven("tar 给了两个归档");
  };
  let index = 0;
  const first = words[0];
  if (first !== undefined && !first.startsWith("-")) {
    index = 1;
    for (const char of first) {
      letter(char);
      if (char !== "f" && char !== "C") continue;
      const given = words[index];
      if (given === undefined) return unproven(`tar 的 ${char} 缺值`);
      index += 1;
      value(char, given);
    }
  }
  let optionsDone = false;
  for (; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (optionsDone || word === "-" || !word.startsWith("-")) {
      members.push(word);
    } else if (word === "--") {
      optionsDone = true;
    } else if (word.startsWith("--")) {
      if (!word.startsWith("--exclude=") && !TAR_LONG.has(word)) unproven(`tar 选项 ${word} 不认`);
    } else {
      const cluster = word.slice(1);
      for (let offset = 0; offset < cluster.length; offset += 1) {
        const char = cluster[offset] ?? "";
        letter(char);
        if (char !== "f" && char !== "C") continue;
        const rest = cluster.slice(offset + 1);
        const given = rest === "" ? words[index + 1] : rest;
        if (given === undefined) return unproven(`tar 的 -${char} 缺值`);
        if (rest === "") index += 1;
        value(char, given);
        break;
      }
    }
  }
  if (mode === null) return unproven("tar 没有 c、x、t 模式");
  // 不给 -f 时归档落到编译时的默认值，不同发行版不一样。归档名带冒号会被当成远程主机。
  if (archive === null) return unproven("tar 要用 -f 指明归档");
  if ((archive as string).includes(":")) unproven("tar 的归档名带冒号，会被当成远程主机");
  prover.path(archive);
  if (dirs.length > 1) unproven("tar 只认一个 -C");
  const dir = dirs[0];
  if (dir !== undefined) prover.path(dir);
  if (mode === "c") {
    if (members.length === 0) unproven("tar c 没有要打包的文件");
    // -C 在命令行上的位置决定它管哪些成员，不去分前后，两个基准都得在里面。
    prover.paths(members);
    if (dir !== undefined) prover.paths(members, prover.resolve(dir));
  } else {
    members.forEach(memberName);
  }
  return { extracts: mode === "x" };
}

const FIND_TEXT: ReadonlySet<string> = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-wholename",
  "-regex",
  "-iregex",
  "-size",
  "-mtime",
  "-atime",
  "-ctime",
  "-mmin",
  "-amin",
  "-cmin",
  "-perm",
  "-user",
  "-group",
  "-uid",
  "-gid",
  "-links",
  "-inum",
  "-printf",
]);
const FIND_BARE: ReadonlySet<string> = new Set([
  "-empty",
  "-print",
  "-print0",
  "-prune",
  "-not",
  "-a",
  "-and",
  "-o",
  "-or",
  "-true",
  "-false",
  "-readable",
  "-writable",
  "-executable",
  "-depth",
  "-xdev",
  "-mount",
  "-noleaf",
  "-ls",
  "(",
  ")",
  "!",
]);
const FIND_TYPE = /^[fdlspbc](?:,[fdlspbc])*$/;

function findCheck(words: readonly string[], prover: Prover): void {
  let index = 0;
  while (words[index] === "-P") index += 1;
  const starts: string[] = [];
  for (; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word.startsWith("-") || FIND_BARE.has(word)) break;
    starts.push(word);
  }
  prover.paths(starts.length === 0 ? ["."] : starts);
  for (; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (FIND_BARE.has(word)) continue;
    const operand = words[index + 1];
    if (operand === undefined) return unproven(`find 的 ${word} 缺值，或不在表里`);
    index += 1;
    if (FIND_TEXT.has(word)) continue;
    if (word === "-type") {
      if (!FIND_TYPE.test(operand)) unproven("find -type 认不出");
    } else if (word === "-maxdepth" || word === "-mindepth") {
      if (!/^\d+$/.test(operand)) unproven(`find ${word} 要数字`);
    } else if (word === "-newer" || word === "-samefile") {
      prover.path(operand);
    } else {
      unproven(`find 谓词 ${word} 不在表里`);
    }
  }
}

/** 命令名已经确认是裸词、不是版本探测。返回它会不会在工作区里建出符号链接。 */
export function checkCommand(name: string, args: readonly string[], prover: Prover): { readonly makesLinks: boolean } {
  if (TEXT_COMMANDS.has(name)) return { makesLinks: false };
  if (name === "tar") return { makesLinks: tarCheck(args, prover).extracts };
  if (name === "find") {
    findCheck(args, prover);
    return { makesLinks: false };
  }
  const spec = SPECS[name];
  if (spec === undefined) return unproven(`${name} 不在表里`);
  const options = getopt(args, spec.options, prover);
  spec.operands(options, prover);
  return { makesLinks: spec.makesLinks?.(options) ?? false };
}
