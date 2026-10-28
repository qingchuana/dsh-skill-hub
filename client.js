/**
 * dsh-skill-hub — Client half.
 *
 * Registers the "技能管理" settings page (order 27, next to the shipped
 * "技能" page from `dsh-agent-skills`, which manages a different set of roots).
 * Every value the page renders comes from the `skillHub` Remote namespace, so
 * the page never guesses at disk state, and every mutation goes back through
 * the Host so validation stays in one place.
 *
 * @module dsh-skill-hub/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-hub',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const PKG = 'dsh-skill-hub';
    const NS = 'skill-hub';
    const STYLE_ID = 'dsh-skill-hub-styles';

    /* ---------------------------------------------------------------- *
     * Remote descriptors
     *
     * The Host half uses the gateway's source mode (it installs the
     * `@deepseek-ai/dsh-typert-protocol/remote-methods` prototype marker), so
     * these descriptors only have to agree on the namespace, the method name
     * and the wire name of each parameter — which is the Host method's
     * parameter name. Parameter codecs must be `mode: 'strict'`; the Client
     * never calls them, because the Host validates every argument itself.
     * ---------------------------------------------------------------- */

    function codec(typeSymbol) {
      return {
        mode: 'strict',
        typeSymbol: `${PKG}/types#${typeSymbol}`,
        create: () => ({ parse: (value) => value }),
      };
    }

    function endpoint(method, parameters = []) {
      return {
        id: `${PKG}#skillHub/${method}`,
        service: 'skillHub',
        namespace: 'skillHub',
        method,
        invocation: { kind: 'direct' },
        parameters,
        result: { mode: 'src-json' },
      };
    }

    /* The gateway derives the wire name from the Host method's own parameter
       name, so this must stay exactly `input` to match `async save(input)`. */
    function payload(typeSymbol) {
      return [{ name: 'input', wire: 'input', source: 'json', codec: codec(typeSymbol) }];
    }

    const REMOTE = {
      package: PKG,
      descriptors: [
        endpoint('state'),
        endpoint('heartbeat'),
        endpoint('read', payload('NameInput')),
        endpoint('validate', payload('DocumentInput')),
        endpoint('save', payload('SaveInput')),
        endpoint('create', payload('CreateInput')),
        endpoint('installDir', payload('InstallDirInput')),
        endpoint('installUrl', payload('InstallUrlInput')),
        /* Named `removeSkill`, not `remove`: the Client refuses a Remote method
           that shadows `RemoteNamespaceService.prototype.remove`. For the same
           reason installation is `installDir`/`installUrl`, never `install`. */
        endpoint('removeSkill', payload('NameInput')),
        endpoint('setInvocation', payload('InvocationInput')),
        endpoint('setConfig', payload('ConfigInput')),
        endpoint('scanDir', payload('ScanInput')),
        endpoint('listLocal', payload('ListLocalInput')),
        endpoint('upload', payload('UploadInput')),
        endpoint('browseRepo', payload('BrowseRepoInput')),
        endpoint('restoreBackup', payload('RestoreInput')),
      ],
    };

    /* ---------------------------------------------------------------- *
     * Dictionaries
     * ---------------------------------------------------------------- */

    const zh = {
      nav: '技能管理',
      title: 'Agent 技能',
      subtitle: '管理 ~/.dsh/skills 下的技能：新建、编辑、启停、从本地目录或 GitHub 安装、删除前自动备份。原生扫描器会自动识别，无需重启。',
      root: '管理目录',
      refresh: '刷新',
      loading: '加载中…',
      mountMissing: '无法连接 Harness 主机侧的技能服务，请刷新页面重试',
      empty: '这个目录还没有技能。可以「新建技能」，或从本地目录 / GitHub 仓库安装。',
      source: '来源',
      managed: '我的技能',
      readOnlyHint: '这个技能来自其他来源，先「复制到我的技能」才能修改',
      modelInvocable: '模型可自动调用',
      userInvocable: '可用 /skill 调用',
      view: '查看',
      edit: '编辑',
      copy: '复制到我的技能',
      remove: '删除',
      add: '新建技能',
      installLocal: '从目录安装',
      installGithub: '从 GitHub 安装',
      installUrl: '从 URL 安装',
      settings: '设置',
      diagTitle: '未被扫描器加载',
      diagIntro: '这些条目在磁盘上，但没进技能注册表。每条的原因：',
      diagNoFile: '目录里没有 SKILL.md',
      diagUnreadable: '文件读不出来（权限或编码）',
      diagRejected: 'frontmatter 不合规，扫描器只写了一行警告日志就跳过了：修正后会自动出现',
      diagAbsent: '磁盘上合规，但注册表里没有它（通常被更高优先级的同名技能盖住，或提供方跳过了这个文件）',
      diagShadowedTitle: '被更高优先级来源覆盖',
      diagShadowedExplain: '同名技能在优先级更高的目录里也存在，模型看到的是那一份。',
      backups: '备份',
      noBackups: '还没有备份。删除或编辑技能时会自动备份到这里。',
      reasonEdit: '编辑',
      reasonDelete: '删除',
      reasonOverwrite: '覆盖同名技能前的备份',
      reasonRestore: '恢复覆盖',
      restore: '恢复',
      restoreHint: '恢复到管理目录；同名技能已存在时会先备份它',
      editorTitle: '编辑技能',
      editorTitleView: '查看技能',
      editorReadOnly: '只读来源：可以查看内容，但不能保存',
      editorOk: 'frontmatter 有效',
      editorBad: 'frontmatter 会被扫描器拒绝',
      editorWarn: '警告',
      editorDirty: '未保存的修改',
      editorPath: '文件',
      cancel: '取消',
      save: '保存',
      close: '关闭',
      createTitle: '新建技能',
      fName: '名称',
      fNameHint: '小写字母、数字与单个连字符，例如 pdf-tools',
      fDescription: '描述',
      fDescriptionHint: '一句话说明这个技能做什么、什么时候用',
      fWhenToUse: '使用时机（可选）',
      fBody: '正文（Markdown）',
      fBodyHint: '留空会生成最小骨架',
      create: '创建',
      installTitle: '安装技能',
      tabLocal: '本地目录',
      tabGithub: 'GitHub 仓库',
      tabUrl: 'URL',
      fSource: '目录、.zip 包或 .md 文件路径',
      fSourceHint: '绝对路径；目录会列出技能，.zip 会解包后列出里面的全部技能',
      pickDirectory: '选择文件夹…',
      pickDirectoryHint: '打开系统文件夹选择框；要装单个 .md，选它所在的文件夹，扫描后它会作为候选列出',
      pickDirectoryMissing: '这个环境没有提供系统文件夹选择框（工作区 UI 服务未挂载），请手动输入路径',
      browseOpen: '浏览…',
      browseHint: '点目录进入下一层，点 .zip / .md 直接扫描它',
      browseUp: '上一级',
      browseClose: '收起',
      browseEmpty: '这个目录里没有可安装的 .zip / .md / .tar.gz',
      browseRoot: '技能根目录',
      browseHome: '主目录',
      browseTruncated: '条目太多，只列出前 400 个；请往下进一层',
      browseUse: '选用',
      kindDir: '目录',
      kindMd: 'MD',
      kindZip: 'ZIP',
      kindArchive: '包',
      pickFile: '选择 .zip / .md 文件…',
      pickFileHint: '打开系统文件窗口，直接选 .zip 技能包或单个 .md',
      pickFileBad: '只支持 .zip / .tar.gz / .md',
      browseRepo: '列出仓库里的技能',
      browseRepoHint: '下载仓库压缩包并列出其中所有含 SKILL.md 的技能，然后一键安装其中一个',
      browseRepoEmpty: '这个仓库里没有找到 SKILL.md',
      browseRepoInvalid: '校验不通过',
      installThis: '安装这个',
      scan: '扫描',
      fRepo: '仓库',
      fRepoHint: 'owner/name，例如 anthropics/skills',
      fRef: '分支或标签',
      fPath: '子路径（可选）',
      fPathHint: '归档里的技能目录，例如 skills/pdf；留空会列出全部候选',
      fUrl: '归档或 .md 的直链',
      fUrlHint: '.tar.gz 走归档安装，.md 直接作为单个技能安装',
      fMirror: '镜像前缀',
      fMirrorHint: 'GitHub 直连不通时使用，例如 https://gh-proxy.com/；留空表示直连',
      fInstallName: '安装为（可选）',
      fInstallNameHint: '留空沿用技能自己的名称',
      candidates: '候选技能',
      candidatesEmpty: '先扫描或填写来源',
      selectHint: '点一个候选来安装它',
      installSelected: '安装所选',
      installAll: '全部安装',
      overwrite: '覆盖同名技能',
      settingsTitle: '技能管理设置',
      fBackupLimit: '保留备份数',
      fBackupLimitHint: '超出后自动删除最旧的备份；0 表示不限制',
      saved: '已保存',
      confirmTitle: '请确认',
      confirmDelete: '删除技能',
      confirmDeleteTail: '？删除前会自动备份，之后可以在「备份」里恢复。',
      yes: '确定',
      no: '取消',
      working: '处理中…',
      installed: '已安装',
      renamed: '已改名',
      renameHint: '名称不合规，将安装为 ',
      skippedExisting: '已存在，跳过',
      rejected: '被拒绝',
      truncatedCopy: '复制不完整（达到 500 文件 / 8 MB 上限，有文件被跳过）',
      scanSkipped: '已跳过',
      overridden: '被覆盖',
      badgeUnregistered: '未注册',
      overriddenHint: '文件里是启用的，但注册表报告的值被其他插件覆盖了（例如 agent-skills 按名字禁用）：模型实际看到的是',
      overriddenModelOn: '模型可调用',
      overriddenModelOff: '模型不可调用',
      overriddenUserOn: '用户可调用',
      overriddenUserOff: '用户不可调用',
      srcUserDsh: '我的技能（~/.dsh/skills）',
      locatedAt: '所在目录：',
      srcUserAgents: '其他 Agent 目录',
      srcProjectDsh: '项目（.dsh/skills）',
      srcProjectAgents: '项目 Agent 目录',
      srcCustom: '自定义目录',
      srcBundled: '内置',
      srcRuntime: '运行时',
    };

    const en = {
      nav: 'Skills',
      title: 'Agent skills',
      subtitle: 'Manage the skills under ~/.dsh/skills: create, edit, toggle, install from a local directory or GitHub, and back up before deleting. The native scanner picks changes up without a restart.',
      root: 'Managed root',
      refresh: 'Refresh',
      loading: 'Loading…',
      mountMissing: 'Cannot reach the Host-side skill service. Refresh the page to retry.',
      empty: 'No skills in this directory yet. Create one, or install from a local directory or a GitHub repository.',
      source: 'Source',
      managed: 'Managed',
      readOnlyHint: 'This skill comes from another source; copy it into your own skills to edit it',
      modelInvocable: 'Model may invoke',
      userInvocable: 'User may invoke',
      view: 'View',
      edit: 'Edit',
      copy: 'Copy into my skills',
      remove: 'Delete',
      add: 'New skill',
      installLocal: 'Install from directory',
      installGithub: 'Install from GitHub',
      installUrl: 'Install from URL',
      settings: 'Settings',
      diagTitle: 'Not loaded by the scanner',
      diagIntro: 'These entries exist on disk but never reached the skill registry. The reason for each:',
      diagNoFile: 'no SKILL.md in this directory',
      diagUnreadable: 'the file cannot be read (permissions or encoding)',
      diagRejected: 'frontmatter invalid, so the scanner logged one warning and skipped it: fix the file and it appears',
      diagAbsent: 'valid on disk, but the registry does not report it (usually a higher-ranked skill of the same name, or the provider skipped this file)',
      diagShadowedTitle: 'Shadowed by a higher-ranked source',
      diagShadowedExplain: 'A skill of the same name exists in a higher-priority root; that is the copy the model sees.',
      backups: 'Backups',
      noBackups: 'No backups yet. Editing or deleting a skill stores one here.',
      reasonEdit: 'edit',
      reasonDelete: 'delete',
      reasonOverwrite: 'before replacing a skill of the same name',
      reasonRestore: 'restore-overwrite',
      restore: 'Restore',
      restoreHint: 'Restores into the managed root; an existing skill of the same name is backed up first',
      editorTitle: 'Edit skill',
      editorTitleView: 'View skill',
      editorReadOnly: 'Read-only source: the content is visible but cannot be saved',
      editorOk: 'frontmatter is valid',
      editorBad: 'the scanner would reject this frontmatter',
      editorWarn: 'Warnings',
      editorDirty: 'Unsaved changes',
      editorPath: 'File',
      cancel: 'Cancel',
      save: 'Save',
      close: 'Close',
      createTitle: 'New skill',
      fName: 'Name',
      fNameHint: 'Lowercase letters, digits and single hyphens, e.g. pdf-tools',
      fDescription: 'Description',
      fDescriptionHint: 'One line saying what the skill does and when to use it',
      fWhenToUse: 'whenToUse (optional)',
      fBody: 'Body (Markdown)',
      fBodyHint: 'Leave empty for a minimal skeleton',
      create: 'Create',
      installTitle: 'Install a skill',
      tabLocal: 'Local directory',
      tabGithub: 'GitHub repository',
      tabUrl: 'URL',
      fSource: 'Directory, .zip package or .md path',
      fSourceHint: 'Absolute path; a directory lists the skills in it, a .zip is unpacked and every skill inside is listed',
      pickDirectory: 'Choose folder…',
      pickDirectoryHint: 'Opens the system folder dialog; to install a single .md, pick its folder and scan — the file is listed as a candidate',
      pickDirectoryMissing: 'This environment offers no system folder dialog (the workspace UI service is not mounted) — type the path instead',
      browseOpen: 'Browse…',
      browseHint: 'Click a folder to descend, click a .zip / .md to scan it',
      browseUp: 'Parent folder',
      browseClose: 'Hide',
      browseEmpty: 'No installable .zip / .md / .tar.gz in this folder',
      browseRoot: 'Skills root',
      browseHome: 'Home',
      browseTruncated: 'Too many entries — only the first 400 are listed; step one level deeper',
      browseUse: 'Use',
      kindDir: 'DIR',
      kindMd: 'MD',
      kindZip: 'ZIP',
      kindArchive: 'PKG',
      pickFile: 'Choose .zip / .md file…',
      pickFileHint: 'Opens the system file dialog to pick a .zip skill package or a single .md',
      pickFileBad: 'Only .zip / .tar.gz / .md are supported',
      browseRepo: 'List skills in repo',
      browseRepoHint: 'Downloads the repository archive and lists every skill with a SKILL.md, so one click installs one of them',
      browseRepoEmpty: 'No SKILL.md found in this repository',
      browseRepoInvalid: 'failed validation',
      installThis: 'Install',
      scan: 'Scan',
      fRepo: 'Repository',
      fRepoHint: 'owner/name, e.g. anthropics/skills',
      fRef: 'Branch or tag',
      fPath: 'Sub-path (optional)',
      fPathHint: 'A skill directory inside the archive, e.g. skills/pdf; leave empty to list every candidate',
      fUrl: 'Direct link to an archive or .md',
      fUrlHint: 'A .tar.gz installs as an archive, a .md installs as one skill',
      fMirror: 'Mirror prefix',
      fMirrorHint: 'For when GitHub is unreachable, e.g. https://gh-proxy.com/; empty means direct',
      fInstallName: 'Install as (optional)',
      fInstallNameHint: 'Empty keeps the skill\'s own name',
      candidates: 'Candidates',
      candidatesEmpty: 'Scan a source first',
      selectHint: 'Pick a candidate to install it',
      installSelected: 'Install selected',
      installAll: 'Install all',
      overwrite: 'Replace an existing skill',
      settingsTitle: 'Skill manager settings',
      fBackupLimit: 'Backups to keep',
      fBackupLimitHint: 'Oldest backups are pruned beyond this; 0 means unlimited',
      saved: 'Saved',
      confirmTitle: 'Please confirm',
      confirmDelete: 'Delete skill ',
      confirmDeleteTail: '? A backup is kept and can be restored from the Backups list.',
      yes: 'Confirm',
      no: 'Cancel',
      working: 'Working…',
      installed: 'Installed',
      renamed: 'Renamed',
      renameHint: 'Name breaks the scanner grammar; installing as ',
      skippedExisting: 'Already present, skipped',
      rejected: 'Rejected',
      truncatedCopy: 'Incomplete copy (hit the 500-file / 8 MB limit; files were skipped)',
      scanSkipped: 'Skipped',
      overridden: 'overridden',
      badgeUnregistered: 'not registered',
      overriddenHint: 'The file enables this skill, but the registry reports a different value — another plugin overrides it by name (for example agent-skills). What the model actually sees:',
      overriddenModelOn: 'model can invoke',
      overriddenModelOff: 'model cannot invoke',
      overriddenUserOn: 'user can invoke',
      overriddenUserOff: 'user cannot invoke',
      srcUserDsh: 'My skills (~/.dsh/skills)',
      locatedAt: 'Directory:',
      srcUserAgents: "Another agent's directory",
      srcProjectDsh: 'Project (.dsh/skills)',
      srcProjectAgents: 'Project agent directory',
      srcCustom: 'Custom directory',
      srcBundled: 'Bundled',
      srcRuntime: 'Runtime',
    };

    /* ---------------------------------------------------------------- *
     * Styles — theme tokens only, prefixed classes
     * ---------------------------------------------------------------- */

    const CSS = `
.skill-hub-root { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 28px; }
.skill-hub-head { display: flex; flex-direction: column; gap: 4px; }
.skill-hub-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.skill-hub-sub { font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.skill-hub-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.skill-hub-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.skill-hub-grow { flex: 1 1 220px; min-width: 0; }
.skill-hub-browse { display: flex; flex-direction: column; gap: 7px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); padding: 8px; }
.skill-hub-browse-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.skill-hub-browser { display: flex; flex-direction: column; gap: 6px; }
.skill-hub-crumb-bar { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; min-width: 0; }
.skill-hub-crumb { height: 22px; max-width: 160px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.skill-hub-crumb:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.skill-hub-crumb:disabled { cursor: default; }
.skill-hub-crumb-current { color: var(--dsw-alias-label-primary); font-weight: 600; }
.skill-hub-files { display: flex; flex-direction: column; max-height: 300px; overflow-y: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.skill-hub-files > * { flex-shrink: 0; }
.skill-hub-file { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; width: 100%; height: 30px; padding: 0 10px; border: 0; border-top: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.skill-hub-file:first-child { border-top: 0; }
.skill-hub-file:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.skill-hub-file:disabled { opacity: .55; cursor: default; }
.skill-hub-kind { flex: 0 0 34px; font-size: 10px; letter-spacing: .04em; color: var(--dsw-alias-label-secondary); }
.skill-hub-kind-dir { color: var(--dsw-alias-brand-primary); }
.skill-hub-file-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skill-hub-file-size { flex: 0 0 auto; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.skill-hub-chevron { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.skill-hub-empty { padding: 14px 10px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); text-align: center; }
.skill-hub-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.skill-hub-row:first-child { border-top: 0; }
.skill-hub-spacer { flex: 1 1 auto; }
.skill-hub-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1; cursor: pointer; transition: background .12s ease, border-color .12s ease; }
.skill-hub-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.skill-hub-btn:disabled { opacity: .5; cursor: default; }
.skill-hub-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.skill-hub-btn-primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--dsw-alias-brand-primary); }
.skill-hub-btn-danger { color: var(--dsw-alias-state-error-primary); }
.skill-hub-list { display: flex; flex-direction: column; gap: 10px; }
.skill-hub-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.skill-hub-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; flex-wrap: wrap; }
.skill-hub-row-main { display: flex; flex-direction: column; gap: 3px; min-width: 200px; flex: 1 1 240px; }
.skill-hub-name { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); flex-wrap: wrap; }
.skill-hub-desc { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.skill-hub-when { font-size: 11.5px; color: var(--dsw-alias-label-secondary); opacity: .9; }
.skill-hub-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.skill-hub-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 9px; font-size: 10.5px; letter-spacing: .02em; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); }
.skill-hub-badge-managed { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.skill-hub-badge-off { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.skill-hub-toggles { display: flex; flex-direction: column; gap: 6px; min-width: 150px; }
.skill-hub-toggle { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.skill-hub-toggle-text { flex: 1 1 auto; }
.skill-hub-detail { border-top: 1px solid var(--dsw-alias-border-l1); padding: 9px 12px; display: flex; flex-direction: column; gap: 6px; background: var(--dsw-alias-bg-base); }
.skill-hub-switch { width: 34px; height: 19px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-state-idle-primary); box-sizing: border-box; position: relative; cursor: pointer; padding: 0; flex: 0 0 auto; }
.skill-hub-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.skill-hub-switch:hover:not(:disabled) { border-color: var(--dsw-alias-label-secondary); }
.skill-hub-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.skill-hub-switch:disabled { opacity: .45; cursor: default; }
.skill-hub-knob { position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: #fff; border: 1px solid var(--dsw-alias-border-l2); box-sizing: border-box; transition: transform .14s ease; }
.skill-hub-switch[aria-checked="true"] .skill-hub-knob { transform: translateX(14px); }
.skill-hub-note { font-size: 11.5px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); word-break: break-word; line-height: 1.55; }
.skill-hub-note-ok { color: var(--dsw-alias-state-success-primary); }
.skill-hub-note-error { color: var(--dsw-alias-state-error-primary); }
.skill-hub-note-warn { color: var(--dsw-alias-state-warn-primary); }
.skill-hub-note-title { font-weight: 600; margin-bottom: 4px; }
.skill-hub-diag-item { padding: 7px 0; border-top: 1px dashed var(--dsw-alias-border-l1); display: flex; flex-direction: column; gap: 3px; }
.skill-hub-diag-item:first-of-type { border-top: none; }
.skill-hub-diag-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-primary); }
.skill-hub-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.skill-hub-form { display: flex; flex-direction: column; gap: 10px; }
.skill-hub-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.skill-hub-field { display: flex; flex-direction: column; gap: 4px; }
.skill-hub-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.skill-hub-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); opacity: .85; line-height: 1.45; }
.skill-hub-input, .skill-hub-select, .skill-hub-textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; padding: 6px 8px; font-family: inherit; }
.skill-hub-textarea { min-height: 96px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.5; }
.skill-hub-textarea-doc { min-height: 340px; }
.skill-hub-input:focus, .skill-hub-select:focus, .skill-hub-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.skill-hub-check { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.skill-hub-modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: flex-start; justify-content: center; padding: 7vh 16px 16px; background: rgba(0,0,0,.34); }
.skill-hub-modal-body { width: min(800px, 100%); max-height: 84vh; overflow: auto; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.skill-hub-modal-body > *:not(.skill-hub-spacer) { flex-shrink: 0; }
.skill-hub-modal-head { display: flex; align-items: center; gap: 10px; }
.skill-hub-modal-title { font-size: 13.5px; font-weight: 600; color: var(--dsw-alias-label-primary); flex: 1 1 auto; }
.skill-hub-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.skill-hub-tab { height: 26px; padding: 0 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: 11.5px; cursor: pointer; }
.skill-hub-tab-active { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary); }
.skill-hub-cand { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); text-align: left; cursor: pointer; width: 100%; }
.skill-hub-cand:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.skill-hub-cand-invalid { cursor: default; opacity: .8; }
.skill-hub-cand-name { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.skill-hub-backup { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px dashed var(--dsw-alias-border-l1); flex-wrap: wrap; }
.skill-hub-backup:first-of-type { border-top: none; }
.skill-hub-backup-main { display: flex; flex-direction: column; gap: 2px; flex: 1 1 200px; }
`;

    /* ---------------------------------------------------------------- *
     * Small UI atoms
     * ---------------------------------------------------------------- */

    function Button({ children, onClick, disabled, variant, title, className }) {
      const cls = ['skill-hub-btn'];
      if (variant === 'primary') cls.push('skill-hub-btn-primary');
      if (variant === 'danger') cls.push('skill-hub-btn-danger');
      if (className !== undefined) cls.push(className);
      return h('button', { type: 'button', className: cls.join(' '), onClick, disabled, title }, children);
    }

    /**
     * The parent of a Windows or POSIX path, without pulling in `node:path`.
     * A bare drive (`C:`) becomes its root so the Host can resolve it.
     */
    function parentOf(path) {
      const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
      if (cut < 0) return '';
      if (cut === 0) return path.slice(0, 1);
      const parent = path.slice(0, cut);
      return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
    }

    /**
     * The directory a browse request should open for a typed path: the path
     * itself when it is a directory, or the folder holding it when the user
     * typed a package.
     */
    function browseTarget(source) {
      const trimmed = String(source ?? '').trim();
      if (trimmed === '') return '';
      if (/[\\/]$/.test(trimmed)) return trimmed;
      return /\.(zip|md|tar\.gz|tgz)$/i.test(trimmed) ? parentOf(trimmed) : trimmed;
    }

    /**
     * Open a real "open file" dialog and resolve the chosen `File`, or `undefined`
     * when the user cancels.
     *
     * This is the one piece of native file choosery a page is allowed: the plugin
     * services expose a directory picker and nothing else, but `<input
     * type="file">` belongs to the browser itself. It yields bytes rather than a
     * path, which is exactly what `api.upload` wants.
     */
    function chooseFile(accept) {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        if (accept !== undefined) input.accept = accept;
        let settled = false;
        let focusTimer;
        let deadline;
        const finish = (value) => {
          if (settled === true) return;
          settled = true;
          if (focusTimer !== undefined) clearTimeout(focusTimer);
          clearTimeout(deadline);
          resolve(value);
        };
        input.addEventListener('change', () => {
          const files = input.files;
          finish(files !== undefined && files !== null && files.length > 0 ? files[0] : undefined);
        });
        /* Chromium fires `cancel` when the dialog is dismissed. */
        input.addEventListener('cancel', () => finish(undefined));
        /* Older builds fire nothing at all on a cancelled dialog: the window just
           regains focus with nothing selected. The delay lets a real `change` win. */
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('focus', () => {
            focusTimer = setTimeout(() => finish(undefined), 400);
          }, { once: true });
        }
        /* Last resort so a dialog that never reports anything cannot leave the
           button disabled forever. Long enough that a real choice always wins. */
        deadline = setTimeout(() => finish(undefined), 300000);
        input.click();
      });
    }

    /** Base64 of a picked file, chunked so a large package cannot blow the stack. */
    async function toBase64(file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      const chunk = 0x8000;
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
      }
      return btoa(binary);
    }

    function Switch({ checked, onChange, label, disabled, title }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          className: 'skill-hub-switch',
          disabled,
          title,
          onClick: () => onChange(!checked),
        },
        h('span', { className: 'skill-hub-knob' }),
      );
    }

    function Field({ label, hint, children }) {
      return h('label', { className: 'skill-hub-field' }, h('span', { className: 'skill-hub-label' }, label), children, hint ? h('span', { className: 'skill-hub-hint' }, hint) : null);
    }

    function TextInput(props) {
      return h('input', { ...props, className: 'skill-hub-input' });
    }

    /**
     * Clickable path segments for the browser, so a deep path is navigated by
     * clicking instead of retyping. Only the tail is kept once it gets long.
     */
    function pathCrumbs(path, keep = 4) {
      const text = String(path ?? '');
      const rooted = text.startsWith('/');
      const parts = text.split(/[\\/]+/).filter((part) => part !== '');
      const crumbs = [];
      let walked = '';
      for (const part of parts) {
        walked = walked === '' ? `${rooted ? '/' : ''}${part}` : `${walked}/${part}`;
        /* A bare drive needs its separator back to be an absolute path again. */
        crumbs.push({ label: part, path: /^[A-Za-z]:$/.test(walked) ? `${walked}\\` : walked });
      }
      if (crumbs.length <= keep) return crumbs;
      return [{ label: '…', path: undefined }, ...crumbs.slice(crumbs.length - keep)];
    }

    /** A human size for a package row: `412 B`, `38.2 KB`, `1.4 MB`. */
    function sizeText(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined;
      if (bytes < 1024) return `${String(bytes)} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    /** The type chip for a row: what the entry actually is, not its role. */
    function kindText(entry, t) {
      if (entry.kind === 'dir') return t('kindDir');
      const lower = String(entry.name).toLowerCase();
      if (lower.endsWith('.md')) return t('kindMd');
      if (lower.endsWith('.zip')) return t('kindZip');
      return t('kindArchive');
    }

    /**
     * The install wizard's folder browser: what the native picker cannot show.
     *
     * It is a real listing — breadcrumbs, quick jumps, one row per entry with its
     * type and size — because the alternative (a column of pill buttons under a
     * raw path) tells the user nothing about what they are about to install.
     */
    function FolderBrowser({ listing, busy, onOpen, onPick, t }) {
      const crumbs = pathCrumbs(listing.path);
      const jump = (label, path) =>
        path === undefined || path === listing.path
          ? null
          : h('button', { type: 'button', className: 'skill-hub-crumb', disabled: busy !== '', onClick: () => onOpen(path) }, label);
      return h(
        'div',
        { className: 'skill-hub-browser' },
        h(
          'div',
          { className: 'skill-hub-crumb-bar' },
          h('button', { type: 'button', className: 'skill-hub-crumb', title: t('browseUp'), disabled: busy !== '' || listing.parent === undefined, onClick: () => onOpen(listing.parent) }, '↑'),
          ...crumbs.map((crumb, index) =>
            h(
              'button',
              {
                key: `${crumb.label}-${String(index)}`,
                type: 'button',
                className: index === crumbs.length - 1 ? 'skill-hub-crumb skill-hub-crumb-current' : 'skill-hub-crumb',
                title: crumb.path ?? crumb.label,
                disabled: busy !== '' || crumb.path === undefined || index === crumbs.length - 1,
                onClick: () => onOpen(crumb.path),
              },
              crumb.label,
            ),
          ),
          h('div', { className: 'skill-hub-spacer' }),
          jump(t('browseRoot'), listing.root),
          jump(t('browseHome'), listing.home),
        ),
        h(
          'div',
          { className: 'skill-hub-files' },
          listing.entries.length === 0
            ? h('div', { className: 'skill-hub-empty' }, t('browseEmpty'))
            : listing.entries.map((entry) =>
                h(
                  'button',
                  {
                    key: entry.path,
                    type: 'button',
                    className: 'skill-hub-file',
                    title: entry.path,
                    disabled: busy !== '',
                    onClick: () => (entry.kind === 'dir' ? onOpen(entry.path) : onPick(entry.path)),
                  },
                  h('span', { className: `skill-hub-kind skill-hub-kind-${entry.kind}` }, kindText(entry, t)),
                  h('span', { className: 'skill-hub-file-name' }, entry.kind === 'dir' ? `${entry.name}/` : entry.name),
                  entry.kind === 'dir' ? null : h('span', { className: 'skill-hub-file-size' }, sizeText(entry.size)),
                  h('span', { className: 'skill-hub-chevron' }, entry.kind === 'dir' ? '›' : t('browseUse')),
                ),
              ),
        ),
        listing.truncated === true ? h('div', { className: 'skill-hub-hint' }, t('browseTruncated')) : null,
        h('div', { className: 'skill-hub-hint' }, t('browseHint')),
      );
    }

    /** The skills a repository holds, each installable in one click. */
    function RepoCatalog({ catalog, busy, t, onInstall }) {
      return h(
        'div',
        { className: 'skill-hub-browse' },
        catalog.skills.length === 0
          ? h('div', { className: 'skill-hub-hint' }, t('browseRepoEmpty'))
          : catalog.skills.map((skill) =>
              h(
                'div',
                { key: skill.path, className: 'skill-hub-row' },
                h(
                  'div',
                  { className: 'skill-hub-grow' },
                  h('div', { className: 'skill-hub-browse-path', title: skill.path }, skill.path),
                  h('div', { className: 'skill-hub-hint' }, skill.description === undefined || skill.description === '' ? skill.name : `${skill.name} — ${skill.description}`),
                  skill.valid === false && skill.renamable !== true ? h('div', { className: 'skill-hub-hint' }, `${t('browseRepoInvalid')}: ${(skill.errors ?? []).join('; ')}`) : null,
                  skill.renamable === true && skill.suggested !== undefined
                    ? h('div', { className: 'skill-hub-hint' }, `${t('renameHint')}${skill.suggested}`)
                    : null,
                ),
                h(Button, { disabled: busy !== '' || (skill.valid === false && skill.renamable !== true), onClick: () => onInstall(skill) }, t('installThis')),
              ),
            ),
        catalog.skipped !== undefined && catalog.skipped.length > 0 ? h('div', { className: 'skill-hub-hint' }, catalog.skipped.join('; ')) : null,
      );
    }

    function Note({ children, tone, title }) {
      const cls = ['skill-hub-note'];
      if (tone === 'ok') cls.push('skill-hub-note-ok');
      if (tone === 'error') cls.push('skill-hub-note-error');
      if (tone === 'warn') cls.push('skill-hub-note-warn');
      return h('div', { className: cls.join(' ') }, title ? h('div', { className: 'skill-hub-note-title' }, title) : null, children);
    }

    function Modal({ title, onClose, children, closeLabel }) {
      return h(
        'div',
        { className: 'skill-hub-modal', role: 'dialog', 'aria-modal': 'true' },
        h(
          'div',
          { className: 'skill-hub-modal-body' },
          h(
            'div',
            { className: 'skill-hub-modal-head' },
            h('div', { className: 'skill-hub-modal-title' }, title),
            h(Button, { onClick: onClose }, closeLabel),
          ),
          children,
        ),
      );
    }

    /** Unwrap the gateway's `{ok, value | error}` result into a promise. */
    async function unwrap(promise) {
      const result = await promise;
      if (result !== null && typeof result === 'object' && 'ok' in result) {
        if (result.ok === true) return result.value;
        const error = result.error;
        throw new Error(error === undefined || error === null ? 'remote call failed' : error.message ?? String(error));
      }
      return result;
    }

    /** Source key → dictionary key. */
    const SOURCE_LABEL = {
      'user-dsh': 'srcUserDsh',
      'user-agents': 'srcUserAgents',
      'project-dsh': 'srcProjectDsh',
      'project-agents': 'srcProjectAgents',
      custom: 'srcCustom',
      bundled: 'srcBundled',
      runtime: 'srcRuntime',
    };

    /** Backup reason the Host records → dictionary key. */
    const REASON_LABEL = { edit: 'reasonEdit', delete: 'reasonDelete', overwrite: 'reasonOverwrite', 'restore-overwrite': 'reasonRestore' };

    /** Localize a backup reason, falling back to the Host's own wording. */
    function reasonLabel(t, reason) {
      const key = REASON_LABEL[reason];
      return key === undefined ? String(reason) : t(key);
    }

    /**
     * Why the scanner skipped one on-disk entry → dictionary key.
     *
     * The Host reports one reason per entry, and they mean very different
     * things: an invalid file the user can fix, versus a registry that simply
     * does not report this root at all.
     */
    const DIAG_LABEL = {
      'no SKILL.md in this directory': 'diagNoFile',
      unreadable: 'diagUnreadable',
      'frontmatter rejected by the scanner': 'diagRejected',
      'valid on disk but absent from the registry': 'diagAbsent',
    };

    /** Localize a skip reason, falling back to the Host's own wording. */
    function diagLabel(t, reason) {
      const key = DIAG_LABEL[reason];
      return key === undefined ? String(reason) : t(key);
    }

    /** Last path segment of a Windows or POSIX path. */
    function tail(path) {
      if (typeof path !== 'string') return '';
      const parts = path.split(/[\\/]/);
      return parts[parts.length - 1] ?? '';
    }

    /* ---------------------------------------------------------------- *
     * The settings page
     * ---------------------------------------------------------------- */

    function SkillHubSection({ api, t, mountError, pickDirectory }) {
      const [view, setView] = useState(undefined);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');
      const [notice, setNotice] = useState(undefined);
      const [expanded, setExpanded] = useState('');
      const [editor, setEditor] = useState(undefined);
      const [creator, setCreator] = useState(undefined);
      const [installer, setInstaller] = useState(undefined);
      const [settings, setSettings] = useState(undefined);
      const [confirming, setConfirming] = useState(undefined);
      const [showBackups, setShowBackups] = useState(false);
      /* Appended after the existing slots so their indices stay stable for the
         test harness, which seeds hook state by position. */
      const [picking, setPicking] = useState(false);
      const [browse, setBrowse] = useState(undefined);
      const [catalog, setCatalog] = useState(undefined);

      const refresh = useCallback(async () => {
        if (api === undefined) return;
        try {
          setView(await unwrap(api.state()));
          setError('');
        } catch (failure) {
          setError(failure?.message ?? String(failure));
        }
      }, [api]);

      useEffect(() => {
        if (api === undefined) return undefined;
        let cancelled = false;
        const tick = async () => {
          try {
            const next = await unwrap(api.state());
            if (!cancelled) {
              setView(next);
              setError('');
            }
            await unwrap(api.heartbeat());
          } catch (failure) {
            if (!cancelled) setError(failure?.message ?? String(failure));
          }
        };
        void tick();
        const timer = setInterval(() => void tick(), 2500);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [api]);

      /* Live validation while editing, so the scanner's verdict is visible
         before the file is written rather than after a silent skip. */
      useEffect(() => {
        if (api === undefined || editor === undefined || editor.readOnly === true) return undefined;
        let cancelled = false;
        const timer = setTimeout(async () => {
          try {
            const verdict = await unwrap(api.validate({ name: editor.name, content: editor.content }));
            if (!cancelled) setEditor((previous) => (previous === undefined ? previous : { ...previous, verdict }));
          } catch {
            /* A validation failure is not worth a toast; the editor still saves through the Host. */
          }
        }, 320);
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }, [api, editor?.content, editor?.name, editor?.readOnly]);

      /** Run one mutation, then adopt the state the Host returns. */
      const run = useCallback(
        async (label, operation) => {
          setBusy(label);
          setNotice(undefined);
          try {
            const result = await operation();
            if (result?.state !== undefined) setView(result.state);
            else await refresh();
            return result;
          } catch (failure) {
            setNotice({ tone: 'error', text: failure?.message ?? String(failure) });
            return undefined;
          } finally {
            setBusy('');
          }
        },
        [refresh],
      );

      /**
       * Adopt one local path as the install source and scan it right away.
       * Filling the field first means a scan that finds nothing still leaves the
       * picked path visible for the next attempt.
       */
      const useFolder = useCallback(
        async (source) => {
          setInstaller((previous) => (previous === undefined ? previous : { ...previous, source, candidates: undefined }));
          const result = await run('scan', () => unwrap(api.scanDir({ source })));
          if (result !== undefined) setInstaller((previous) => (previous === undefined ? previous : { ...previous, candidates: result.candidates, kind: result.kind, skipped: result.skipped }));
        },
        [run, api],
      );

      /**
       * List one directory level for the folder browser. This does not go
       * through `run`: a listing is not a mutation, so it must not re-read the
       * whole inventory.
       */
      const listFolder = useCallback(
        async (target) => {
          setBusy('browse');
          setNotice(undefined);
          try {
            const listing = await unwrap(api.listLocal({ path: target }));
            if (listing !== undefined) setBrowse(listing);
          } catch (failure) {
            setNotice({ tone: 'error', text: failure?.message ?? String(failure) });
          } finally {
            setBusy('');
          }
        },
        [api],
      );

      /**
       * Take a file from a real "open file" dialog. The browser hands over bytes
       * and no path, so the bytes travel to the Host, which writes them to a temp
       * file and returns the path the ordinary scan/install pipeline expects.
       */
      const pickPackage = useCallback(
        async (file) => {
          const received = await unwrap(api.upload({ name: file.name, data: await toBase64(file) }));
          if (received?.source !== undefined) await useFolder(received.source);
          return received;
        },
        [api, useFolder],
      );

      /** List what a repository holds, so one click can install one of its skills. */
      const listRepo = useCallback(
        async (wanted) => {
          setBusy('repo');
          setNotice(undefined);
          try {
            const listing = await unwrap(api.browseRepo({ repo: wanted.repo, ref: wanted.ref, mirror: wanted.mirror }));
            /* Remember what was listed, not what the fields say now: the install
               click must fetch exactly the repository this list came from. */
            if (listing !== undefined) setCatalog({ ...listing, mirror: wanted.mirror, url: wanted.url });
          } catch (failure) {
            setNotice({ tone: 'error', text: failure?.message ?? String(failure) });
          } finally {
            setBusy('');
          }
        },
        [api],
      );

      /** Install one skill out of the listed repository. */
      const installRepoSkill = useCallback(
        async (skill) => {
          await run('install', () =>
            unwrap(
              api.installUrl({
                repo: catalog?.repo === undefined || catalog.repo === '' ? undefined : catalog.repo,
                ref: catalog?.ref,
                url: catalog?.url,
                path: skill.path,
                mirror: catalog?.mirror,
                name: installer?.name ?? '',
                all: false,
                overwrite: installer?.overwrite === true,
              }),
            ),
          );
        },
        /* `installer` is undefined while the wizard is closed, so it is the whole
           object — never `installer.name` — that may be read here. */
        [run, api, catalog, installer],
      );

      const skills = view?.skills ?? [];
      const broken = view?.broken ?? [];
      const shadowed = view?.shadowed ?? [];
      const backups = view?.backups ?? [];

      /* The heading renders in every state, so a first load shows what page this
         is instead of a bare "loading" line. */
      const heading = (root) =>
        h(
          'div',
          { className: 'skill-hub-head' },
          h('div', { className: 'skill-hub-title' }, t('title')),
          h('div', { className: 'skill-hub-sub' }, t('subtitle')),
          root === undefined ? null : h('div', { className: 'skill-hub-path' }, `${t('root')}: ${root}`),
        );

      if (api === undefined) {
        return h(
          'div',
          { className: 'skill-hub-root' },
          heading(undefined),
          h(Note, { tone: 'error' }, mountError === '' || mountError === undefined ? t('mountMissing') : `${t('mountMissing')} — ${mountError}`),
        );
      }
      if (view === undefined) {
        return h(
          'div',
          { className: 'skill-hub-root' },
          heading(undefined),
          error === '' ? h('div', { className: 'skill-hub-sub' }, t('loading')) : h(Note, { tone: 'error' }, error),
        );
      }

      /* An unknown source id must show itself rather than be relabelled as a
         directory it may not live in. */
      const sourceLabel = (source) => {
        const key = SOURCE_LABEL[source];
        return key === undefined ? String(source ?? '') : t(key);
      };

      const invokeSwitch = (skill, which) =>
        h(
          'div',
          { className: 'skill-hub-toggle' },
          h(Switch, {
            checked: which === 'model' ? skill.modelInvocable : skill.userInvocable,
            disabled: skill.writable !== true || busy !== '',
            label: which === 'model' ? t('modelInvocable') : t('userInvocable'),
            title: skill.writable === true ? undefined : t('readOnlyHint'),
            onChange: (next) =>
              void run('toggle', () =>
                unwrap(api.setInvocation({ name: skill.name, ...(which === 'model' ? { modelInvocable: next } : { userInvocable: next }) })),
              ),
          }),
          h('span', { className: 'skill-hub-toggle-text' }, which === 'model' ? t('modelInvocable') : t('userInvocable')),
        );

      const openEditor = (skill) =>
        void (async () => {
          const loaded = await run('read', () => unwrap(api.read({ name: skill.name })));
          if (loaded === undefined) return;
          setEditor({ name: skill.name, content: loaded.content ?? '', readOnly: loaded.writable !== true, file: loaded.file, verdict: loaded.validation, dirty: false });
        })();

      const installResult = (result) => {
        if (result === undefined) return;
        const parts = [];
        if ((result.installed ?? []).length > 0) parts.push(`${t('installed')}: ${result.installed.map((entry) => `${entry.name} (${String(entry.files)})`).join(', ')}`);
        /* A rescue is worth saying out loud: the folder is not the name the file claims. */
        const renamed = (result.installed ?? []).filter((entry) => entry.renamed !== undefined);
        if (renamed.length > 0) parts.push(`${t('renamed')}: ${renamed.map((entry) => `${entry.renamed.from} → ${entry.name}`).join(', ')}`);
        if ((result.skippedExisting ?? []).length > 0) parts.push(`${t('skippedExisting')}: ${result.skippedExisting.join(', ')}`);
        if ((result.rejected ?? []).length > 0) parts.push(`${t('rejected')}: ${result.rejected.map((entry) => `${entry.name} — ${entry.errors.join('; ')}`).join('; ')}`);
        /* A partial copy is not a success: say so instead of showing a green note. */
        const truncated = (result.installed ?? []).filter((entry) => entry.truncated === true);
        if (truncated.length > 0) {
          setNotice({ tone: 'error', text: `${parts.join(' · ')}${parts.length === 0 ? '' : ' · '}${t('truncatedCopy')}: ${truncated.map((entry) => entry.name).join(', ')}` });
          return;
        }
        setNotice(parts.length === 0 ? { tone: 'ok', text: t('saved') } : { tone: 'ok', text: parts.join(' · ') });
      };

      return h(
        'div',
        { className: 'skill-hub-root' },
        heading(view.root),
        notice === undefined ? null : h(Note, { tone: notice.tone }, notice.text),
        error === '' ? null : h(Note, { tone: 'error' }, error),
        h(
          'div',
          { className: 'skill-hub-bar' },
          h(Button, { variant: 'primary', onClick: () => setCreator({ name: '', description: '', whenToUse: '', body: '' }), disabled: busy !== '' }, t('add')),
          h(Button, { onClick: () => setInstaller({ tab: 'local', source: '', repo: '', ref: 'main', path: '', url: '', mirror: view.config?.mirror ?? '', name: '', candidates: undefined, all: false, overwrite: false }), disabled: busy !== '' }, t('installLocal')),
          h(Button, {
            onClick: () => setInstaller({ tab: 'github', source: '', repo: '', ref: 'main', path: '', url: '', mirror: view.config?.mirror ?? '', name: '', candidates: undefined, all: false, overwrite: false }),
            disabled: busy !== '',
          }, t('installGithub')),
          h('div', { className: 'skill-hub-spacer' }),
          h(Button, { onClick: () => setSettings({ mirror: view.config?.mirror ?? '', backupLimit: view.config?.backupLimit ?? 20 }) }, t('settings')),
          h(Button, { onClick: () => void refresh(), disabled: busy !== '' }, t('refresh')),
        ),
        broken.length > 0
          ? h(
              Note,
              { tone: 'warn', title: `${String(broken.length)} ${t('diagTitle')}` },
              h('div', null, t('diagIntro')),
              ...broken.map((entry) =>
                h(
                  'div',
                  { className: 'skill-hub-diag-item', key: `broken-${String(entry.file)}` },
                  h(
                    'div',
                    { className: 'skill-hub-diag-head' },
                    h('span', { className: 'skill-hub-cand-name' }, entry.name),
                    h('span', { className: 'skill-hub-badge' }, diagLabel(t, entry.reason)),
                  ),
                  h('div', { className: 'skill-hub-mono' }, entry.directory),
                  entry.errors.length === 0 ? null : h('div', { className: 'skill-hub-hint' }, entry.errors.join('; ')),
                ),
              ),
            )
          : null,
        shadowed.length > 0
          ? h(
              Note,
              { tone: 'warn', title: `${String(shadowed.length)} ${t('diagShadowedTitle')}` },
              h('div', null, t('diagShadowedExplain')),
              ...shadowed.map((entry) =>
                h(
                  'div',
                  { className: 'skill-hub-diag-item', key: `shadowed-${String(entry.name)}` },
                  h('div', { className: 'skill-hub-diag-head' }, h('span', { className: 'skill-hub-cand-name' }, entry.name)),
                  h('div', { className: 'skill-hub-hint' }, entry.reason),
                ),
              ),
            )
          : null,
        skills.length === 0
          ? h(Note, null, t('empty'))
          : h(
              'div',
              { className: 'skill-hub-list' },
              ...skills.map((skill) => {
                const isOpen = expanded === skill.name;
                return h(
                  'div',
                  { className: 'skill-hub-card', key: `skill-${skill.name}` },
                  h(
                    'div',
                    { className: 'skill-hub-row' },
                    h(
                      'div',
                      { className: 'skill-hub-row-main' },
                      h(
                        'div',
                        { className: 'skill-hub-name' },
                        skill.name,
                        h('span', { className: `skill-hub-badge${skill.writable ? ' skill-hub-badge-managed' : ''}` }, skill.writable ? t('managed') : sourceLabel(skill.source)),
                        !skill.modelInvocable || !skill.userInvocable ? h('span', { className: 'skill-hub-badge skill-hub-badge-off' }, 'off') : null,
                        skill.overridden === true ? h('span', { className: 'skill-hub-badge skill-hub-badge-off' }, t('overridden')) : null,
                        skill.registered === false ? h('span', { className: 'skill-hub-badge skill-hub-badge-off' }, t('badgeUnregistered')) : null,
                      ),
                      h('div', { className: 'skill-hub-desc' }, skill.description),
                      skill.whenToUse === undefined ? null : h('div', { className: 'skill-hub-when' }, skill.whenToUse),
                      /* The `source` id is a coarse category, not a location: the
                         provider reports `user-agents` for whatever it found under
                         `.claude`, `.codex` or `.agents`. Show the real directory
                         instead of letting a label imply the wrong path. */
                      skill.writable === true || typeof skill.directory !== 'string'
                        ? null
                        : h('div', { className: 'skill-hub-hint' }, `${t('locatedAt')} ${skill.directory}`),
                      skill.overridden === true
                        ? h(
                            'div',
                            { className: 'skill-hub-hint' },
                            `${t('overriddenHint')} ${skill.registryModelInvocable === true ? t('overriddenModelOn') : t('overriddenModelOff')} · ${skill.registryUserInvocable === true ? t('overriddenUserOn') : t('overriddenUserOff')}`,
                          )
                        : null,
                    ),
                    h('div', { className: 'skill-hub-toggles' }, invokeSwitch(skill, 'model'), invokeSwitch(skill, 'user')),
                    h(
                      'div',
                      { className: 'skill-hub-actions' },
                      h(Button, { onClick: () => setExpanded(isOpen ? '' : skill.name) }, isOpen ? t('close') : t('view')),
                      h(Button, { onClick: () => openEditor(skill), disabled: busy !== '' }, skill.writable ? t('edit') : t('view')),
                      skill.writable
                        ? null
                        : h(
                            Button,
                            {
                              disabled: busy !== '',
                              onClick: () =>
                                setInstaller({
                                  tab: 'local',
                                  source: skill.directory ?? '',
                                  repo: '',
                                  ref: 'main',
                                  path: '',
                                  url: '',
                                  mirror: view.config?.mirror ?? '',
                                  name: '',
                                  candidates: undefined,
                                  all: false,
                                }),
                            },
                            t('copy'),
                          ),
                      skill.writable
                        ? h(
                            Button,
                            {
                              variant: 'danger',
                              disabled: busy !== '',
                              onClick: () =>
                                setConfirming({
                                  text: `${t('confirmDelete')}${skill.name}${t('confirmDeleteTail')}`,
                                  action: () =>
                                    void run('remove', async () => {
                                      const result = await unwrap(api.removeSkill({ name: skill.name }));
                                      return result;
                                    }),
                                }),
                            },
                            t('remove'),
                          )
                        : null,
                    ),
                  ),
                  isOpen
                    ? h(
                        'div',
                        { className: 'skill-hub-detail' },
                        h('div', { className: 'skill-hub-mono' }, `${t('source')}: ${sourceLabel(skill.source)} · ${skill.provider ?? 'filesystem'}`),
                        h('div', { className: 'skill-hub-mono' }, skill.file ?? skill.directory ?? ''),
                      )
                    : null,
                );
              }),
            ),
        h(
          'div',
          { className: 'skill-hub-bar' },
          h(Button, { onClick: () => setShowBackups(!showBackups) }, `${t('backups')} (${String(backups.length)})`),
          h('div', { className: 'skill-hub-hint' }, t('restoreHint')),
        ),
        showBackups
          ? backups.length === 0
            ? h(Note, null, t('noBackups'))
            : h(
                'div',
                { className: 'skill-hub-card', style: { padding: '8px 12px' } },
                ...backups.map((entry) =>
                  h(
                    'div',
                    { className: 'skill-hub-backup', key: entry.id },
                    h(
                      'div',
                      { className: 'skill-hub-backup-main' },
                      h('div', { className: 'skill-hub-cand-name' }, entry.name),
                      h('div', { className: 'skill-hub-hint' }, `${entry.id}${entry.at === undefined ? '' : ` · ${entry.at}`}${entry.reason === undefined ? '' : ` · ${reasonLabel(t, entry.reason)}`}`),
                    ),
                    h(
                      Button,
                      {
                        disabled: busy !== '' || entry.restorable !== true,
                        onClick: () => void run('restore', () => unwrap(api.restoreBackup({ id: entry.id }))),
                      },
                      t('restore'),
                    ),
                  ),
                ),
              )
          : null,
        editor === undefined
          ? null
          : h(
              Modal,
              { title: `${editor.readOnly ? t('editorTitleView') : t('editorTitle')} — ${editor.name}`, onClose: () => setEditor(undefined), closeLabel: t('close') },
              editor.readOnly ? h(Note, null, t('editorReadOnly')) : null,
              editor.file === undefined ? null : h('div', { className: 'skill-hub-mono' }, `${t('editorPath')}: ${editor.file}`),
              h('textarea', {
                className: 'skill-hub-textarea skill-hub-textarea-doc',
                value: editor.content,
                readOnly: editor.readOnly === true,
                onChange: (event) => setEditor({ ...editor, content: event.target.value, dirty: true }),
              }),
              editor.verdict === undefined
                ? null
                : editor.verdict.ok === true
                  ? h(Note, { tone: 'ok' }, `${t('editorOk')}${(editor.verdict.warnings ?? []).length === 0 ? '' : ` · ${t('editorWarn')}: ${editor.verdict.warnings.join('; ')}`}`)
                  : h(Note, { tone: 'error', title: t('editorBad') }, (editor.verdict.errors ?? []).join('; ')),
              h(
                'div',
                { className: 'skill-hub-bar' },
                h('div', { className: 'skill-hub-spacer' }),
                editor.dirty ? h('div', { className: 'skill-hub-hint' }, t('editorDirty')) : null,
                h(Button, { onClick: () => setEditor(undefined) }, t('cancel')),
                h(
                  Button,
                  {
                    variant: 'primary',
                    disabled: busy !== '' || editor.readOnly === true || editor.dirty !== true,
                    onClick: () =>
                      void run('save', async () => {
                        const result = await unwrap(api.save({ name: editor.name, content: editor.content }));
                        setEditor(undefined);
                        return result;
                      }),
                  },
                  t('save'),
                ),
              ),
            ),
        creator === undefined
          ? null
          : h(
              Modal,
              { title: t('createTitle'), onClose: () => setCreator(undefined), closeLabel: t('cancel') },
              h(
                'div',
                { className: 'skill-hub-form' },
                h(
                  'div',
                  { className: 'skill-hub-grid' },
                  h(Field, { label: t('fName'), hint: t('fNameHint') }, h(TextInput, { value: creator.name, onChange: (event) => setCreator({ ...creator, name: event.target.value }) })),
                  h(Field, { label: t('fWhenToUse') }, h(TextInput, { value: creator.whenToUse, onChange: (event) => setCreator({ ...creator, whenToUse: event.target.value }) })),
                ),
                h(Field, { label: t('fDescription'), hint: t('fDescriptionHint') }, h(TextInput, { value: creator.description, onChange: (event) => setCreator({ ...creator, description: event.target.value }) })),
                h(Field, { label: t('fBody'), hint: t('fBodyHint') }, h('textarea', { className: 'skill-hub-textarea', value: creator.body, onChange: (event) => setCreator({ ...creator, body: event.target.value }) })),
                h(
                  'div',
                  { className: 'skill-hub-bar' },
                  h('div', { className: 'skill-hub-spacer' }),
                  h(Button, { onClick: () => setCreator(undefined) }, t('cancel')),
                  h(
                    Button,
                    {
                      variant: 'primary',
                      disabled: busy !== '' || creator.name === '' || creator.description === '',
                      onClick: () =>
                        void run('create', async () => {
                          const result = await unwrap(api.create({ name: creator.name, description: creator.description, whenToUse: creator.whenToUse, body: creator.body }));
                          setCreator(undefined);
                          return result;
                        }),
                    },
                    t('create'),
                  ),
                ),
              ),
            ),
        installer === undefined
          ? null
          : h(
              Modal,
              { title: t('installTitle'), onClose: () => setInstaller(undefined), closeLabel: t('cancel') },
              h(
                'div',
                { className: 'skill-hub-tabs' },
                ...['local', 'github', 'url'].map((tab) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      key: tab,
                      className: `skill-hub-tab${installer.tab === tab ? ' skill-hub-tab-active' : ''}`,
                      onClick: () => setInstaller({ ...installer, tab, candidates: undefined }),
                    },
                    tab === 'local' ? t('tabLocal') : tab === 'github' ? t('tabGithub') : t('tabUrl'),
                  ),
                ),
              ),
              installer.tab === 'local'
                ? h(
                    'div',
                    { className: 'skill-hub-form' },
                    h(
                      Field,
                      { label: t('fSource'), hint: t('fSourceHint') },
                      h(
                        'div',
                        { className: 'skill-hub-bar' },
                        h('div', { className: 'skill-hub-grow' }, h(TextInput, { value: installer.source, onChange: (event) => setInstaller({ ...installer, source: event.target.value, candidates: undefined }) })),
                        /* Always rendered: when the picker cannot be resolved the
                           click reports why, which is strictly more useful than a
                           button that silently never appears. */
                        h(
                          Button,
                          {
                            disabled: picking === true,
                            title: t('pickDirectoryHint'),
                            onClick: () => {
                              void (async () => {
                                if (typeof pickDirectory !== 'function') {
                                  setError(t('pickDirectoryMissing'));
                                  return;
                                }
                                setPicking(true);
                                try {
                                  const picked = await pickDirectory();
                                  /* A cancelled dialog resolves null: leave the
                                     typed path alone. */
                                  if (typeof picked === 'string' && picked !== '') {
                                    await useFolder(picked);
                                    void listFolder(picked);
                                  }
                                } catch (failure) {
                                  setError(failure?.message ?? String(failure));
                                } finally {
                                  setPicking(false);
                                }
                              })();
                            },
                          },
                          t('pickDirectory'),
                        ),
                        /* The panel below is toggled from here, so it can be closed
                           again without leaving the wizard. */
                        h(
                          Button,
                          {
                            variant: browse === undefined ? undefined : 'primary',
                            disabled: busy !== '',
                            title: t('browseHint'),
                            onClick: () => {
                              if (browse === undefined) void listFolder(browseTarget(installer.source));
                              else setBrowse(undefined);
                            },
                          },
                          browse === undefined ? t('browseOpen') : t('browseClose'),
                        ),
                        /* A page cannot ask for a file path, but `<input type="file">`
                           is the browser's own dialog; the chosen bytes are uploaded
                           and become an ordinary install source. */
                        h(
                          Button,
                          {
                            disabled: picking === true,
                            title: t('pickFileHint'),
                            onClick: () => {
                              void (async () => {
                                setError(undefined);
                                setPicking(true);
                                try {
                                  const file = await chooseFile('.zip,.md,.tar.gz,.tgz');
                                  /* Cancelled, or the browser never opened a dialog. */
                                  if (file === undefined) return;
                                  if (!/\.(zip|md|tar\.gz|tgz)$/i.test(String(file.name ?? ''))) {
                                    setError(t('pickFileBad'));
                                    return;
                                  }
                                  await pickPackage(file);
                                } catch (failure) {
                                  setError(failure?.message ?? String(failure));
                                } finally {
                                  setPicking(false);
                                }
                              })();
                            },
                          },
                          t('pickFile'),
                        ),
                      ),
                    ),
                    browse === undefined
                      ? null
                      : h(FolderBrowser, {
                          listing: browse,
                          busy,
                          t,
                          onOpen: (path) => void listFolder(path),
                          onPick: (path) => {
                            setBrowse(undefined);
                            void useFolder(path);
                          },
                        }),
                  )
                : null,
              installer.tab === 'github'
                ? h(
                    'div',
                    { className: 'skill-hub-form' },
                    h(
                      'div',
                      { className: 'skill-hub-grid' },
                      h(Field, { label: t('fRepo'), hint: t('fRepoHint') }, h(TextInput, { value: installer.repo, onChange: (event) => setInstaller({ ...installer, repo: event.target.value, candidates: undefined }) })),
                      h(Field, { label: t('fRef') }, h(TextInput, { value: installer.ref, onChange: (event) => setInstaller({ ...installer, ref: event.target.value, candidates: undefined }) })),
                      h(Field, { label: t('fPath'), hint: t('fPathHint') }, h(TextInput, { value: installer.path, onChange: (event) => setInstaller({ ...installer, path: event.target.value }) })),
                      h(Field, { label: t('fMirror'), hint: t('fMirrorHint') }, h(TextInput, { value: installer.mirror, onChange: (event) => setInstaller({ ...installer, mirror: event.target.value, candidates: undefined }) })),
                    ),
                    /* Browse-then-install, the way a skills panel usually works:
                       list what the repository holds and click the one you want. */
                    h(
                      'div',
                      { className: 'skill-hub-bar' },
                      h(
                        Button,
                        {
                          disabled: busy !== '' || installer.repo === '',
                          title: t('browseRepoHint'),
                          onClick: () => void listRepo({ repo: installer.repo, ref: installer.ref, mirror: installer.mirror }),
                        },
                        t('browseRepo'),
                      ),
                      catalog === undefined ? null : h('span', { className: 'skill-hub-label' }, `${catalog.repo === '' ? t('fUrl') : catalog.repo}@${catalog.ref}`),
                    ),
                    catalog === undefined
                      ? null
                      : h(RepoCatalog, {
                          catalog,
                          busy,
                          t,
                          onInstall: (skill) => void installRepoSkill(skill),
                        }),
                  )
                : null,
              installer.tab === 'url'
                ? h(
                    'div',
                    { className: 'skill-hub-form' },
                    h(Field, { label: t('fUrl'), hint: t('fUrlHint') }, h(TextInput, { value: installer.url, onChange: (event) => setInstaller({ ...installer, url: event.target.value, candidates: undefined }) })),
                    h(Field, { label: t('fMirror'), hint: t('fMirrorHint') }, h(TextInput, { value: installer.mirror, onChange: (event) => setInstaller({ ...installer, mirror: event.target.value, candidates: undefined }) })),
                  )
                : null,
              h(Field, { label: t('fInstallName'), hint: t('fInstallNameHint') }, h(TextInput, { value: installer.name, onChange: (event) => setInstaller({ ...installer, name: event.target.value }) })),
              h(
                'div',
                { className: 'skill-hub-grid' },
                h(
                  'label',
                  { className: 'skill-hub-check' },
                  h('input', { type: 'checkbox', checked: installer.all === true, onChange: (event) => setInstaller({ ...installer, all: event.target.checked }) }),
                  t('installAll'),
                ),
                h(
                  'label',
                  { className: 'skill-hub-check' },
                  h('input', { type: 'checkbox', checked: installer.overwrite === true, onChange: (event) => setInstaller({ ...installer, overwrite: event.target.checked }) }),
                  t('overwrite'),
                ),
              ),
              h(
                'div',
                { className: 'skill-hub-bar' },
                installer.tab === 'local'
                  ? h(
                      Button,
                      {
                        disabled: busy !== '' || installer.source === '',
                        onClick: () => void useFolder(installer.source),
                      },
                      t('scan'),
                    )
                  : null,
                installer.tab === 'github' || installer.tab === 'url'
                  ? h(
                      Button,
                      {
                        disabled: busy !== '' || (installer.tab === 'github' ? installer.repo === '' : installer.url === ''),
                        onClick: () =>
                          void (async () => {
                            const result = await run('probe', () =>
                              unwrap(
                                api.installUrl({
                                  repo: installer.tab === 'github' ? installer.repo : undefined,
                                  ref: installer.tab === 'github' ? installer.ref : undefined,
                                  url: installer.tab === 'url' ? installer.url : undefined,
                                  path: installer.path === '' ? undefined : installer.path,
                                  mirror: installer.mirror,
                                  all: installer.all === true,
                                  overwrite: installer.overwrite === true,
                                  name: installer.name === '' ? undefined : installer.name,
                                }),
                              ),
                            );
                            installResult(result);
                            if (result?.needSelection === true) setInstaller((previous) => (previous === undefined ? previous : { ...previous, candidates: result.candidates, archive: true }));
                            else setInstaller(undefined);
                          })(),
                      },
                      t('installSelected'),
                    )
                  : null,
                h('div', { className: 'skill-hub-spacer' }),
                installer.tab === 'local'
                  ? h(
                      Button,
                      {
                        variant: 'primary',
                        disabled: busy !== '' || installer.source === '',
                        onClick: () =>
                          void (async () => {
                            const result = await run('install', () =>
                              unwrap(api.installDir({ source: installer.source, name: installer.name === '' ? undefined : installer.name, overwrite: installer.overwrite === true, all: true })),
                            );
                            installResult(result);
                            if (result !== undefined && (result.needSelection !== true)) setInstaller(undefined);
                          })(),
                      },
                      t('installAll'),
                    )
                  : null,
              ),
              (installer.candidates ?? []).length === 0
                ? h('div', { className: 'skill-hub-hint' }, t('candidatesEmpty'))
                : h(
                    'div',
                    { className: 'skill-hub-form' },
                    h('div', { className: 'skill-hub-label' }, t('candidates')),
                    ...installer.candidates.map((candidate) => {
                      const label = candidate.name ?? tail(candidate.path ?? candidate.directory ?? '');
                      const where = candidate.directory ?? candidate.path;
                      return h(
                        'button',
                        {
                          type: 'button',
                          key: String(candidate.path ?? candidate.directory ?? label),
                          className: `skill-hub-cand${candidate.valid === false ? ' skill-hub-cand-invalid' : ''}`,
                          disabled: busy !== '' || (candidate.valid === false && candidate.renamable !== true),
                          onClick: () =>
                            void (async () => {
                              const result = await run('install', () =>
                                unwrap(
                                  installer.tab === 'local'
                                    ? api.installDir({ source: installer.source, path: candidate.name ?? label, name: installer.name === '' ? undefined : installer.name, overwrite: installer.overwrite === true })
                                    : api.installUrl({
                                        repo: installer.repo === '' ? undefined : installer.repo,
                                        ref: installer.ref,
                                        url: installer.url === '' ? undefined : installer.url,
                                        path: candidate.path ?? label,
                                        mirror: installer.mirror,
                                        name: installer.name === '' ? undefined : installer.name,
                                        overwrite: installer.overwrite === true,
                                      }),
                                ),
                              );
                              installResult(result);
                              if (result !== undefined) setInstaller(undefined);
                            })(),
                        },
                        h('span', { className: 'skill-hub-cand-name' }, label),
                        candidate.description === undefined ? null : h('span', { className: 'skill-hub-hint' }, candidate.description),
                        where === undefined ? null : h('span', { className: 'skill-hub-mono' }, where),
                        candidate.valid === false && candidate.renamable !== true ? h('span', { className: 'skill-hub-hint' }, (candidate.errors ?? []).join('; ')) : null,
                        /* A name the scanner would skip is installed under a legal
                           one instead, so say that before the click, not after. */
                        candidate.renamable === true && candidate.suggested !== undefined
                          ? h('span', { className: 'skill-hub-bar' }, h('span', { className: 'skill-hub-hint' }, t('renameHint')), h('span', { className: 'skill-hub-mono' }, candidate.suggested))
                          : null,
                      );
                    }),
                    h('div', { className: 'skill-hub-hint' }, t('selectHint')),
                  ),
              (installer.skipped ?? []).length === 0 ? null : h(Note, null, `${t('scanSkipped')}: ${installer.skipped.join('; ')}`),
            ),
        settings === undefined
          ? null
          : h(
              Modal,
              { title: t('settingsTitle'), onClose: () => setSettings(undefined), closeLabel: t('cancel') },
              h(
                'div',
                { className: 'skill-hub-form' },
                h(Field, { label: t('fMirror'), hint: t('fMirrorHint') }, h(TextInput, { value: settings.mirror, onChange: (event) => setSettings({ ...settings, mirror: event.target.value }) })),
                h(
                  Field,
                  { label: t('fBackupLimit'), hint: t('fBackupLimitHint') },
                  h('input', {
                    type: 'number',
                    min: 0,
                    className: 'skill-hub-input',
                    value: settings.backupLimit,
                    onChange: (event) => setSettings({ ...settings, backupLimit: Number(event.target.value) }),
                  }),
                ),
                h(
                  'div',
                  { className: 'skill-hub-bar' },
                  h('div', { className: 'skill-hub-spacer' }),
                  h(Button, { onClick: () => setSettings(undefined) }, t('cancel')),
                  h(
                    Button,
                    {
                      variant: 'primary',
                      disabled: busy !== '',
                      onClick: () =>
                        void (async () => {
                          const result = await run('config', () => unwrap(api.setConfig({ mirror: settings.mirror, backupLimit: settings.backupLimit })));
                          if (result !== undefined) {
                            setSettings(undefined);
                            setNotice({ tone: 'ok', text: t('saved') });
                          }
                        })(),
                    },
                    t('save'),
                  ),
                ),
              ),
            ),
        confirming === undefined
          ? null
          : h(
              Modal,
              { title: t('confirmTitle'), onClose: () => setConfirming(undefined), closeLabel: t('no') },
              h('div', { className: 'skill-hub-sub' }, confirming.text),
              h(
                'div',
                { className: 'skill-hub-bar' },
                h('div', { className: 'skill-hub-spacer' }),
                h(Button, { onClick: () => setConfirming(undefined) }, t('no')),
                h(
                  Button,
                  {
                    variant: 'danger',
                    onClick: () => {
                      const action = confirming.action;
                      setConfirming(undefined);
                      action();
                    },
                  },
                  t('yes'),
                ),
              ),
            ),
        busy === '' ? null : h('div', { className: 'skill-hub-hint' }, `${t('working')} ${busy}`),
      );
    }

    /* ---------------------------------------------------------------- *
     * Client plugin body
     * ---------------------------------------------------------------- */

    const inject = ['slots', 'remote', 'locale'];

    async function apply(ctx) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      if (document.getElementById(STYLE_ID) === null) document.head.appendChild(style);
      ctx.effect(() => () => {
        style.remove();
      }, `${PKG}: styles`);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${PKG}: dictionaries`);
      /* A failed mount must not remove the page: it degrades to an explanation,
         which is the only Client-side signal this plugin can show without
         access to the browser console. */
      let mountError = '';
      try {
        await ctx.remote.$mount(REMOTE);
      } catch (failure) {
        mountError = failure?.message ?? String(failure);
      }
      const t = ctx.locale.bind(NS);
      /* The system folder picker, resolved lazily on every click: this Client
         half can load before the workspace UI service registers, so an
         apply-time snapshot would leave a dead button for the whole session.
         The desktop shell's bridge wins when it is present. Nothing here is a
         hard inject dependency, so an environment without either picker is
         reported where the user clicked instead of silently losing the button. */
      const pickDirectory = async () => {
        const bridge = globalThis.__DSH_DIRECTORY_PICKER__;
        if (typeof bridge?.pick === 'function') return await bridge.pick();
        const workspace = ctx.get('uiWorkspace');
        if (typeof workspace?.pickDirectory !== 'function') throw new Error(t('pickDirectoryMissing'));
        return await workspace.pickDirectory();
      };
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'skill-hub',
            order: 27,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ api: ctx.get('remote.skillHub'), mountError, pickDirectory }),
          },
          SkillHubSection,
        ),
      );
    }

    return { inject, apply };
  },
});
