// OS catalog mapping a friendly id to the container image and the
// environment variable that selects the version (Windows: VERSION,
// Linux: BOOT). Mirrors the upstream dockur/windows and qemus/qemu tables.

export const WINDOWS_IMAGE = "dockurr/windows";
export const LINUX_IMAGE = "qemus/qemu";

const windows = (id, version, label) => ({ type: "windows", id, version, label, image: WINDOWS_IMAGE });
const linux = (id, boot, label) => ({ type: "linux", id, boot, label, image: LINUX_IMAGE });

const WINDOWS = [
  windows("win11", "11", "Windows 11 Pro"),
  windows("win11l", "11l", "Windows 11 LTSC"),
  windows("win11e", "11e", "Windows 11 Enterprise"),
  windows("win10", "10", "Windows 10 Pro"),
  windows("win10l", "10l", "Windows 10 LTSC"),
  windows("win10e", "10e", "Windows 10 Enterprise"),
  windows("win8", "8e", "Windows 8.1 Enterprise"),
  windows("win7", "7u", "Windows 7 Ultimate"),
  windows("winvista", "vu", "Windows Vista Ultimate"),
  windows("winxp", "xp", "Windows XP Professional"),
  windows("win2k", "2k", "Windows 2000 Professional"),
  windows("win2025", "2025", "Windows Server 2025"),
  windows("win2022", "2022", "Windows Server 2022"),
  windows("win2019", "2019", "Windows Server 2019"),
  windows("win2016", "2016", "Windows Server 2016"),
  windows("win2012", "2012", "Windows Server 2012"),
  windows("win2008", "2008", "Windows Server 2008"),
  windows("win2003", "2003", "Windows Server 2003"),
  windows("tiny11", "tiny11", "Tiny11"),
  windows("tiny10", "tiny10", "Tiny10"),
  windows("core11", "core11", "Tiny11 Core"),
  windows("reactos", "reactos", "ReactOS"),
];

const LINUX = [
  linux("ubuntu", "ubuntu", "Ubuntu Desktop"),
  linux("ubuntus", "ubuntus", "Ubuntu Server"),
  linux("xubuntu", "xubuntu", "Xubuntu"),
  linux("kubuntu", "kubuntu", "Kubuntu"),
  linux("arch", "arch", "Arch Linux"),
  linux("manjaro", "manjaro", "Manjaro"),
  linux("cachy", "cachy", "CachyOS"),
  linux("debian", "debian", "Debian"),
  linux("fedora", "fedora", "Fedora"),
  linux("centos", "centos", "CentOS"),
  linux("rocky", "rocky", "Rocky Linux"),
  linux("alma", "alma", "Alma Linux"),
  linux("alpine", "alpine", "Alpine Linux"),
  linux("mint", "mint", "Linux Mint"),
  linux("kali", "kali", "Kali Linux"),
  linux("gentoo", "gentoo", "Gentoo"),
  linux("nixos", "nixos", "NixOS"),
  linux("suse", "suse", "OpenSUSE"),
  linux("slack", "slack", "Slackware"),
  linux("mx", "mx", "MX Linux"),
  linux("tails", "tails", "Tails"),
  linux("zorin", "zorin", "Zorin OS"),
  linux("zima", "zima", "ZimaOS"),
];

export const CATALOG = [...WINDOWS, ...LINUX];

export function findOs(id) {
  return CATALOG.find((e) => e.id === id) ?? null;
}

export function listOs() {
  return CATALOG.map((e) => ({
    id: e.id,
    type: e.type,
    image: e.image,
    selector: e.type === "windows" ? e.version : e.boot,
    label: e.label,
  }));
}
