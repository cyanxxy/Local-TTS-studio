# Installs Open TTS on Windows 11 x64 by building the latest release from
# source. GitHub Releases are source-only (see docs/releasing.md), so this is
# the one-command path for people who are not developing the app. From
# PowerShell:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/cyanxxy/Local-TTS-studio/main/scripts/install-windows.ps1)))
#
# Options go after the closing parenthesis, e.g. `... ))) -Check`. The plain
# `irm ... | iex` form also works, without options.
#
# Run it again to update. What it builds with (source, Node, LibTorch, Rust if
# rustup is not already installed) lives in one folder, $env:OPEN_TTS_INSTALL_HOME,
# and Rust build output in <system drive>\ott-target\installer, which stays
# short for the 260-character path limit. The Visual Studio Build Tools, Git,
# CMake and LLVM it installs through winget are shared system tools and stay.
#
# Options:
#   -Check          Report what is missing; change nothing.
#   -Ref REF        Build a tag or branch instead of the latest release.
#   -Source DIR     Build an existing checkout in place (for developers).
#   -AppDir DIR     Install the app into DIR instead of %LOCALAPPDATA%\Programs.
#   -Help           Show this help.
#
# Written for Windows PowerShell 5.1, which every Windows 11 has, and runs
# unchanged in PowerShell 7. Everything is one function called on the last
# line; PowerShell parses the whole text before running any of it, so a
# download cut short by the network runs nothing.

# Options are parsed from the raw arguments rather than a param() block:
# Windows PowerShell 5.1 rejects a top-level param() under `irm | iex`, and this
# way `-Check`, `--check` and `-check` all work through every entry point.
function Install-OpenTts([object[]]$Arguments) {
  Set-StrictMode -Version 3.0
  $ErrorActionPreference = 'Stop'
  # Invoke-WebRequest's progress bar slows Windows PowerShell downloads tenfold.
  $ProgressPreference = 'SilentlyContinue'

  $RepoSlug = 'cyanxxy/Local-TTS-studio'
  $RepoUrl = "https://github.com/$RepoSlug.git"
  $AppName = 'Open TTS'
  $MinWindowsBuild = 22000
  $MinFreeGb = 40
  # tch 0.20 links LibTorch 2.7.0 (docs/local-runtimes.md). PyTorch publishes no
  # checksums for these archives, so the digest is pinned here and in
  # .github/workflows/rust-bridge.yml.
  $LibtorchUrl = 'https://download.pytorch.org/libtorch/cpu/libtorch-win-shared-with-deps-2.7.0%2Bcpu.zip'
  $LibtorchSha256 = '2267cd447052bc839df147afc03865b5569336f9a45c43841142844e2011a561'
  # Mirrors the Windows prerequisites in scripts/setup.mjs and docs/development.md:
  # MSVC with the Windows SDK, CMake, and the libclang bindgen loads, all from
  # one Build Tools install.
  $BuildToolsId = 'Microsoft.VisualStudio.2022.BuildTools'
  $BuildToolsOverride = '--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --add Microsoft.VisualStudio.Component.VC.CMake.Project --add Microsoft.VisualStudio.Component.VC.Llvm.Clang'

  $InstallHome = if ($env:OPEN_TTS_INSTALL_HOME) { [IO.Path]::GetFullPath($env:OPEN_TTS_INSTALL_HOME) } else { Join-Path $env:LOCALAPPDATA 'OpenTTS-Installer' }
  $ToolchainDir = Join-Path $InstallHome 'toolchain'
  $Missing = New-Object System.Collections.Generic.List[string]

  function Say([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
  function Note([string]$Message) { Write-Host "    $Message" }
  function Warn([string]$Message) { Write-Host "Warning: $Message" -ForegroundColor Yellow }
  function Die([string]$Message) { throw $Message }

  # In -Check mode a missing piece is recorded and reported at the end;
  # otherwise it is fatal unless the caller installs it.
  function Missing([string]$Message) {
    if ($Check) {
      $Missing.Add($Message)
      Note "missing: $Message"
    } else {
      Die $Message
    }
  }

  # Runs a native program, judging it by its exit code alone. When output is
  # redirected (a log, CI), Windows PowerShell turns each stderr line into an
  # error record, and under Stop the first progress line cargo or npm prints
  # there would end the run; those lines are printed as plain text instead.
  function Invoke-NativeUnchecked([string]$File, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    & $File @Arguments 2>&1 | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.ToString() } else { $_ }
    }
  }

  function Invoke-Native([string]$File, [string[]]$Arguments) {
    Invoke-NativeUnchecked $File $Arguments
    if ($LASTEXITCODE -ne 0) { Die "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE." }
  }

  # A native program's stdout, or null when it fails; stderr is dropped.
  function Get-NativeOutput([string]$File, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    $output = & $File @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return $output
  }

  # Picks up what a winget install added to the saved PATH, keeping what this
  # run already put in front (the private Node, Visual Studio's CMake).
  function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$env:Path;$machine;$user"
  }

  function Add-PathFront([string]$Directory) {
    $env:Path = "$Directory;$env:Path"
  }

  function Find-Command([string]$Name) {
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Path }
    return $null
  }

  $Check = $false
  $Help = $false
  $Ref = ''
  $Source = ''
  $AppDir = ''
  $list = @(@($Arguments) | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
  for ($i = 0; $i -lt $list.Count; $i++) {
    $name = $list[$i].ToLowerInvariant().TrimStart('-')
    if ($name -in @('ref', 'source', 'appdir', 'app-dir')) {
      if ($i + 1 -ge $list.Count) { Die "$($list[$i]) needs a value (see -Help)." }
      $i++
      if ($name -eq 'ref') { $Ref = $list[$i] }
      elseif ($name -eq 'source') { $Source = $list[$i] }
      else { $AppDir = $list[$i] }
    } elseif ($name -eq 'check') {
      $Check = $true
    } elseif ($name -in @('help', 'h', '?')) {
      $Help = $true
    } else {
      Die "Unknown option: $($list[$i]) (see -Help)."
    }
  }

  function Show-Usage {
    @'
Builds and installs Open TTS on Windows 11 x64.

Usage: install-windows.ps1 [-Check] [-Ref REF | -Source DIR] [-AppDir DIR]

  -Check          Report what is missing; change nothing.
  -Ref REF        Build a tag or branch instead of the latest release.
  -Source DIR     Build an existing checkout in place (for developers).
  -AppDir DIR     Install the app into DIR instead of %LOCALAPPDATA%\Programs.
  -Help           Show this help.

Set OPEN_TTS_INSTALL_HOME to keep the installer's files somewhere other than
%LOCALAPPDATA%\OpenTTS-Installer.
'@ | Write-Host
  }

  function Test-Platform {
    Say 'Checking this PC'
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Die 'This installer is for Windows. On a Mac, use scripts/install-macos.sh.' }
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    # 9 is x64; Windows on Arm reports 12, even to an emulated x64 PowerShell.
    if ($cpu.Architecture -ne 9) { Die 'Open TTS builds for x64 Windows only; Windows on Arm is not supported.' }
    if ([int]$os.BuildNumber -lt $MinWindowsBuild) { Die "Open TTS needs Windows 11; this PC runs $($os.Caption) (build $($os.BuildNumber))." }
    Note "$($os.Caption) (build $($os.BuildNumber)) on x64"

    # Only a drive-letter folder has a free-space figure; skip the warning for a share.
    $root = [IO.Path]::GetPathRoot($InstallHome)
    if ($root -match '^[A-Za-z]:') {
      $drive = Get-PSDrive -Name $root.Substring(0, 1)
      $freeGb = [math]::Floor($drive.Free / 1GB)
      if ($freeGb -lt $MinFreeGb) {
        Warn "Only $freeGb GB free. The build needs about $MinFreeGb GB (most of it the Visual Studio Build Tools and Rust output), and models need more later."
      }
    }
  }

  # Smart App Control in enforcement mode blocks unsigned programs, and a local
  # build is unsigned. Stop before a half-hour build that could not run.
  function Test-SmartAppControl {
    $state = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState -ErrorAction SilentlyContinue)
    if (-not $state) { return }
    switch ($state.VerifiedAndReputablePolicyState) {
      1 {
        Missing 'Smart App Control is on, and it blocks unsigned apps such as this local build. Turn it off in Windows Security > App & browser control > Smart App Control, then run the installer again.'
      }
      2 {
        Warn 'Smart App Control is in evaluation mode. If Windows switches it on, it will block this unsigned build; turning it off in Windows Security > App & browser control avoids that.'
      }
    }
  }

  # winget is only needed for what is missing, so its absence is reported with
  # the first thing it would have installed rather than up front.
  function Test-Winget {
    return [bool](Find-Command 'winget')
  }

  # What to report for a missing prerequisite: one the installer will fetch
  # through winget, or, without winget, one the user has to install.
  function Get-MissingText([string]$What, [string]$Detail, [bool]$HaveWinget) {
    if ($HaveWinget) { return "$What ($Detail)" }
    return "$What. winget (App Installer) is not available to install it: install it yourself, or install App Installer from the Microsoft Store, then run the installer again."
  }

  function Install-WingetPackage([string]$Id, [string]$Label, [string]$Override) {
    Say "Installing $Label (Windows may ask for permission)"
    $arguments = @('install', '--id', $Id, '--exact', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
    if ($Override) { $arguments += @('--override', $Override) }
    Invoke-NativeUnchecked 'winget' $arguments
    # winget reports "already installed" and "reboot required" as failures; the
    # caller checks for the tool itself instead.
    Update-SessionPath
  }

  function Get-VsWhere {
    $path = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $path) { return $path }
    return $null
  }

  # The newest Visual Studio installation with the x64 C++ tools, or null.
  function Find-VisualStudio {
    $vswhere = Get-VsWhere
    if (-not $vswhere) { return $null }
    $found = Get-NativeOutput $vswhere @('-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath')
    if (-not $found) { return $null }
    return ($found | Select-Object -First 1).Trim()
  }

  function Initialize-BuildTools([bool]$HaveWinget) {
    Say 'Checking the Visual Studio C++ build tools'
    $vs = Find-VisualStudio
    if (-not $vs) {
      if ($Check -or -not $HaveWinget) {
        Missing (Get-MissingText 'the Visual Studio C++ build tools' 'the installer installs Visual Studio 2022 Build Tools through winget, about 7 GB' $HaveWinget)
        return
      }
      Install-WingetPackage $BuildToolsId 'Visual Studio 2022 Build Tools with the C++ workload' $BuildToolsOverride
      $vs = Find-VisualStudio
      if (-not $vs) { Die 'The Visual Studio Build Tools did not install. Install them with the "Desktop development with C++" workload, then run the installer again.' }
    }
    Note "C++ tools: $vs"

    # CMake: one on PATH, or the copy the C++ workload includes, or winget's.
    if (-not (Find-Command 'cmake')) {
      $vsCmake = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin'
      if (Test-Path (Join-Path $vsCmake 'cmake.exe')) {
        Add-PathFront $vsCmake
      } elseif ($Check -or -not $HaveWinget) {
        Missing (Get-MissingText 'CMake' 'the installer installs it through winget' $HaveWinget)
      } else {
        Install-WingetPackage 'Kitware.CMake' 'CMake' $null
        if (-not (Find-Command 'cmake')) { Die 'CMake did not install. Install it from https://cmake.org, then run the installer again.' }
      }
    }
    $cmake = Find-Command 'cmake'
    if ($cmake) { Note "CMake: $cmake" }

    # libclang, which bindgen loads to generate the llama.cpp bindings.
    $libclangDirs = @(
      $env:LIBCLANG_PATH,
      (Join-Path $vs 'VC\Tools\Llvm\x64\bin'),
      (Join-Path $env:ProgramFiles 'LLVM\bin')
    ) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'libclang.dll')) }
    $libclang = $libclangDirs | Select-Object -First 1
    if (-not $libclang) {
      if ($Check -or -not $HaveWinget) {
        Missing (Get-MissingText 'libclang' 'the installer installs LLVM through winget' $HaveWinget)
        return
      }
      Install-WingetPackage 'LLVM.LLVM' 'LLVM' $null
      $libclang = Join-Path $env:ProgramFiles 'LLVM\bin'
      if (-not (Test-Path (Join-Path $libclang 'libclang.dll'))) { Die 'LLVM did not install. Install it from https://llvm.org, then run the installer again.' }
    }
    $env:LIBCLANG_PATH = $libclang
    Note "libclang: $libclang"
  }

  function Initialize-Git([bool]$HaveWinget) {
    if (Find-Command 'git') { return }
    $bundled = Join-Path $env:ProgramFiles 'Git\cmd'
    if (Test-Path (Join-Path $bundled 'git.exe')) {
      Add-PathFront $bundled
      return
    }
    if ($Check -or -not $HaveWinget) {
      Missing (Get-MissingText 'Git' 'the installer installs it through winget' $HaveWinget)
      return
    }
    Install-WingetPackage 'Git.Git' 'Git' $null
    if (-not (Find-Command 'git')) { Die 'Git did not install. Install it from https://git-scm.com, then run the installer again.' }
  }

  function Get-LatestReleaseTag {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoSlug/releases/latest" -Headers @{ 'User-Agent' = 'open-tts-installer' }
    return $release.tag_name
  }

  function Initialize-Source {
    if ($Source) {
      $resolved = (Resolve-Path $Source).Path
      if (-not (Test-Path (Join-Path $resolved 'package.json')) -or -not (Test-Path (Join-Path $resolved 'scripts\setup.mjs'))) {
        Die "$resolved is not an Open TTS checkout."
      }
      Say "Using the checkout at $resolved"
      return $resolved
    }

    $sourceDir = Join-Path $InstallHome 'source'
    $target = $Ref
    if (-not $target) {
      try { $target = Get-LatestReleaseTag } catch { $target = $null }
      if (-not $target) { Die 'Could not look up the latest release on GitHub. Check your connection, or pass -Ref.' }
    }
    if ($Check) {
      Say "Would build $target in $sourceDir"
      return $sourceDir
    }

    Say "Fetching Open TTS $target"
    # core.autocrlf=false keeps the tree byte for byte as committed: Git for
    # Windows defaults to CRLF, and the vendored Rust tree is digest-pinned.
    if (Test-Path (Join-Path $sourceDir '.git')) {
      # This folder belongs to the installer; never reset anything else.
      $origin = Get-NativeOutput 'git' @('-C', $sourceDir, 'remote', 'get-url', 'origin')
      if ($origin -ne $RepoUrl) { Die "$sourceDir is not the installer's checkout (origin: $origin). Move it away and run again." }
      Invoke-Native 'git' @('-C', $sourceDir, '-c', 'core.autocrlf=false', 'fetch', '--depth', '1', '--quiet', 'origin', $target) | Out-Null
      Invoke-Native 'git' @('-C', $sourceDir, '-c', 'core.autocrlf=false', 'checkout', '--quiet', '--force', '--detach', 'FETCH_HEAD') | Out-Null
    } else {
      New-Item -ItemType Directory -Force -Path $InstallHome | Out-Null
      if (Test-Path $sourceDir) { Remove-Item -Recurse -Force $sourceDir }
      Invoke-Native 'git' @('-c', 'core.autocrlf=false', 'clone', '--quiet', '--depth', '1', '--branch', $target, '--config', 'core.autocrlf=false', $RepoUrl, $sourceDir) | Out-Null
    }
    Note "at $(Get-NativeOutput 'git' @('-C', $sourceDir, 'rev-parse', '--short', 'HEAD'))"
    return $sourceDir
  }

  function Get-FileSha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
  }

  # Windows 10 and 11 ship bsdtar, which unpacks a zip far faster than Expand-Archive.
  function Expand-Zip([string]$Zip, [string]$Destination) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Invoke-Native 'tar.exe' @('-xf', $Zip, '-C', $Destination)
  }

  function New-TemporaryDirectory {
    $path = Join-Path ([IO.Path]::GetTempPath()) ("open-tts-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $path | Out-Null
    return $path
  }

  # A private Node at the version in .nvmrc, and the npm pinned in package.json's
  # packageManager, so a system Node or nvm-windows setup is never changed.
  function Initialize-Node([string]$SourceDir) {
    $nodeDir = Join-Path $ToolchainDir 'node'
    $nodeExe = Join-Path $nodeDir 'node.exe'
    if ($Check) {
      Say 'Checking Node.js'
      if (Test-Path $nodeExe) { Note "private Node $(Get-NativeOutput $nodeExe @('--version')) is installed" }
      else { Note 'the installer downloads its own Node.js from nodejs.org' }
      return
    }

    $want = (Get-Content (Join-Path $SourceDir '.nvmrc') -Raw).Trim().TrimStart('v')
    $have = if (Test-Path $nodeExe) { Get-NativeOutput $nodeExe @('--version') } else { '' }
    if ($have -ne "v$want") {
      Say "Downloading Node.js $want"
      $name = "node-v$want-win-x64"
      $base = "https://nodejs.org/dist/v$want"
      $tmp = New-TemporaryDirectory
      try {
        $zip = Join-Path $tmp "$name.zip"
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$name.zip" -OutFile $zip
        $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt").Content
        $line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))\s*$" } | Select-Object -First 1
        if (-not $line -or ($line -split '\s+')[0].ToLowerInvariant() -ne (Get-FileSha256 $zip)) { Die 'The Node.js download failed its checksum.' }
        Expand-Zip $zip $tmp
        New-Item -ItemType Directory -Force -Path $ToolchainDir | Out-Null
        if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
        Move-Item (Join-Path $tmp $name) $nodeDir
      } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
      }
    }
    Add-PathFront $nodeDir

    # npm.cmd, not npm: the npm.ps1 shim beside it is a script file, which the
    # default Restricted execution policy refuses to run.
    $wantNpm = Get-NativeOutput $nodeExe @('-p', "require(process.argv[1]).packageManager.replace(/^npm@/, '')", (Join-Path $SourceDir 'package.json'))
    if (-not $wantNpm) { Die 'Could not read the npm version from package.json.' }
    if ((Get-NativeOutput 'npm.cmd' @('--version')) -ne $wantNpm) {
      Say "Installing npm $wantNpm"
      # Run outside the checkout so its .npmrc does not apply, and pin the prefix
      # so a user-level npm prefix cannot redirect the install.
      Push-Location $ToolchainDir
      try {
        $env:npm_config_prefix = $nodeDir
        Invoke-Native 'npm.cmd' @('install', '--global', '--no-audit', '--no-fund', "npm@$wantNpm") | Out-Null
      } finally {
        Remove-Item Env:npm_config_prefix -ErrorAction SilentlyContinue
        Pop-Location
      }
    }
    Note "Node $(Get-NativeOutput 'node.exe' @('--version')), npm $(Get-NativeOutput 'npm.cmd' @('--version'))"
  }

  # Reuses LIBTORCH when it already names LibTorch 2.7.0; otherwise downloads the
  # pinned CPU build into the installer's folder.
  function Initialize-Libtorch {
    Say 'Checking LibTorch 2.7.0'
    if ($env:LIBTORCH -and (Test-Path (Join-Path $env:LIBTORCH 'build-version'))) {
      $version = (Get-Content (Join-Path $env:LIBTORCH 'build-version') -Raw).Trim()
      if ($version -match '^2\.7\.0(\+|$)') {
        Note "using LIBTORCH=$env:LIBTORCH ($version)"
        return
      }
      Warn "LIBTORCH points to LibTorch $version; using the installer's own 2.7.0 instead."
    }

    $root = Join-Path $ToolchainDir 'libtorch-2.7.0-cpu'
    $libtorch = Join-Path $root 'libtorch'
    if (Test-Path (Join-Path $libtorch 'build-version')) {
      $env:LIBTORCH = $libtorch
      Note "using $libtorch"
      return
    }
    if ($Check) {
      Note 'the installer downloads LibTorch 2.7.0 (CPU, about 200 MB) from pytorch.org'
      return
    }

    Say 'Downloading LibTorch 2.7.0 (CPU, about 200 MB)'
    $tmp = New-TemporaryDirectory
    try {
      $zip = Join-Path $tmp 'libtorch.zip'
      Invoke-WebRequest -UseBasicParsing -Uri $LibtorchUrl -OutFile $zip
      if ((Get-FileSha256 $zip) -ne $LibtorchSha256) { Die 'The LibTorch download failed its checksum.' }
      if (Test-Path $root) { Remove-Item -Recurse -Force $root }
      Expand-Zip $zip $root
    } finally {
      Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
    $env:LIBTORCH = $libtorch
    Note "installed to $libtorch"
  }

  # Uses an existing rustup. Without one, installs rustup into the installer's
  # folder with --no-modify-path, so the user's PATH is not edited.
  function Initialize-Rust([string]$SourceDir) {
    Say 'Checking Rust'
    $rustup = Find-Command 'rustup'
    if (-not $rustup) {
      $candidates = @(
        (Join-Path $env:USERPROFILE '.cargo\bin\rustup.exe'),
        (Join-Path $ToolchainDir 'rust\cargo\bin\rustup.exe')
      )
      $rustup = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
      if ($rustup -and $rustup.StartsWith($ToolchainDir)) {
        $env:RUSTUP_HOME = Join-Path $ToolchainDir 'rust\rustup'
        $env:CARGO_HOME = Join-Path $ToolchainDir 'rust\cargo'
      }
    }

    if (-not $rustup) {
      if ($Check) {
        Note 'the installer installs its own rustup and Rust toolchain'
        return
      }
      Say 'Installing rustup'
      $env:RUSTUP_HOME = Join-Path $ToolchainDir 'rust\rustup'
      $env:CARGO_HOME = Join-Path $ToolchainDir 'rust\cargo'
      New-Item -ItemType Directory -Force -Path $env:RUSTUP_HOME, $env:CARGO_HOME | Out-Null
      $tmp = New-TemporaryDirectory
      try {
        $init = Join-Path $tmp 'rustup-init.exe'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' -OutFile $init
        Invoke-Native $init @('-y', '--no-modify-path', '--profile', 'minimal', '--default-toolchain', 'none', '--quiet')
      } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
      }
      $rustup = Join-Path $env:CARGO_HOME 'bin\rustup.exe'
    }
    # rustup's proxies must win over any other Rust on PATH, which ignores the pin.
    Add-PathFront (Split-Path $rustup)

    if ($Check) {
      Note "using $rustup"
      return
    }
    $toolchain = Get-Content (Join-Path $SourceDir 'rust-toolchain.toml') | Where-Object { $_ -match '^channel\s*=\s*"(.+)"' } | Select-Object -First 1
    if (-not $toolchain) { Die 'Could not read the Rust version from rust-toolchain.toml.' }
    $channel = [regex]::Match($toolchain, '"(.+)"').Groups[1].Value
    Invoke-Native $rustup @('toolchain', 'install', $channel, '--profile', 'minimal', '--component', 'clippy', '--component', 'rustfmt') | Out-Null
    Note "Rust $channel via $rustup"
  }

  function Test-AppRunning {
    return [bool](Get-Process -Name $AppName -ErrorAction SilentlyContinue)
  }

  function Invoke-Build([string]$SourceDir) {
    Say 'Building Open TTS (the first build takes 30 to 60 minutes)'
    # Keep the installer's Rust output in a short, known folder: llama.cpp's
    # CMake tree nests deep enough to cross MAX_PATH under a long profile path.
    # A developer's -Source checkout keeps scripts/rust-target-dir.mjs's default.
    if (-not $Source -and -not $env:CARGO_TARGET_DIR) {
      $env:CARGO_TARGET_DIR = Join-Path "$env:SystemDrive\" 'ott-target\installer'
    }
    Push-Location $SourceDir
    try {
      Invoke-Native 'node.exe' @('scripts/setup.mjs', '--desktop', '--check')
      Invoke-Native 'npm.cmd' @('ci', '--no-audit', '--no-fund')
      Invoke-Native 'npm.cmd' @('run', 'build:electron')
      Invoke-Native 'npx.cmd' @('--no-install', 'electron-builder', '--win', 'nsis', '--x64')
    } finally {
      Pop-Location
    }
  }

  # Runs the NSIS installer electron-builder made, silently and for this user
  # only, so the app gets Start menu and desktop shortcuts and an entry in
  # Settings > Apps that uninstalls it.
  function Install-App([string]$SourceDir) {
    $setup = Get-ChildItem (Join-Path $SourceDir 'release') -Filter 'Open-TTS-*-Windows-x64-*.exe' |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $setup) { Die "The build finished but no installer was found in $(Join-Path $SourceDir 'release')." }
    if (Test-AppRunning) { Die "Quit $AppName and run the installer again; the new build is ready." }

    Say "Installing $AppName"
    $arguments = '/S /currentuser'
    # NSIS takes /D last and unquoted, spaces included, so the arguments go
    # over as one string that Start-Process passes on untouched.
    if ($AppDir) { $arguments += " /D=$([IO.Path]::GetFullPath($AppDir))" }
    $process = Start-Process -FilePath $setup.FullName -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) { Die "The $AppName setup exited with code $($process.ExitCode)." }

    $installed = if ($AppDir) { [IO.Path]::GetFullPath($AppDir) } else { Join-Path $env:LOCALAPPDATA "Programs\$AppName" }
    if (-not (Test-Path (Join-Path $installed "$AppName.exe"))) { Die "Setup finished but $AppName.exe is not in $installed." }
    return $installed
  }

  if ($Help) {
    Show-Usage
    return
  }
  if ($Source -and $Ref) { Die 'Use either -Source or -Ref, not both.' }

  $transcript = $false
  if (-not $Check) {
    New-Item -ItemType Directory -Force -Path $InstallHome | Out-Null
    # Keep a log next to the build for troubleshooting.
    Start-Transcript -Path (Join-Path $InstallHome 'install.log') | Out-Null
    $transcript = $true
  }
  try {
    Test-Platform
    Test-SmartAppControl
    $haveWinget = Test-Winget
    Initialize-BuildTools $haveWinget
    if (-not $Source) { Initialize-Git $haveWinget }
    $sourceDir = Initialize-Source
    Initialize-Node $sourceDir
    Initialize-Libtorch
    Initialize-Rust $sourceDir

    if ($Check) {
      if ($AppDir) { Say "App folder: $AppDir" } else { Say "App folder: $(Join-Path $env:LOCALAPPDATA "Programs\$AppName")" }
      if ($Missing.Count -eq 0) {
        Say 'Ready to install. Run the installer without -Check.'
      } else {
        Say 'Before installing:'
        foreach ($item in $Missing) { Note "- $item" }
      }
      return
    }

    if (Test-AppRunning) { Die "Quit $AppName first, then run the installer again." }
    Invoke-Build $sourceDir
    $installed = Install-App $sourceDir

    Say "$AppName is installed: $installed"
    Note 'Open it from the Start menu. Voice models download the first time you use them.'
    Note 'To update, run the same install command again.'
    Note "Build files (several GB) are in: $InstallHome"
    if ($env:CARGO_TARGET_DIR) { Note "Rust build output is in: $env:CARGO_TARGET_DIR" }
    Note "Uninstall: remove $AppName in Settings > Apps, then delete those folders. Your library and models are in $(Join-Path $env:LOCALAPPDATA $AppName)."
  } finally {
    if ($transcript) { Stop-Transcript | Out-Null }
  }
}

# Get-Variable rather than $args: under `irm | iex` this line runs at the global
# scope, where $args is unset and a strict-mode profile would make reading it fatal.
Install-OpenTts -Arguments (Get-Variable -Name args -ValueOnly -ErrorAction SilentlyContinue)
