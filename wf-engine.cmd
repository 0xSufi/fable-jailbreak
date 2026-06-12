@echo off
:: wf-engine.cmd -- Windows launcher for the standalone dynamic-workflow runner.
::
:: Mirrors the logic of the POSIX `wf-engine` bash script:
::   1. Resolves @anthropic-ai/sdk (sets WF_SDK_PATH + NODE_PATH).
::   2. Delegates to wf-engine.mjs via node, forwarding all arguments.
::
:: Usage: wf-engine --project DIR (--script F | --name N | --inline "JS") [opts]
::        wf-engine --help
setlocal enabledelayedexpansion

:: Directory of this script, without trailing backslash.
set "HERE=%~dp0"
if "!HERE:~-1!"=="\" set "HERE=!HERE:~0,-1!"
set "ENGINE=!HERE!\wf-engine.mjs"

:: Search for @anthropic-ai/sdk. First hit wins.
:: Mirrors the bash candidate list (monorepo path is Linux-only; skipped here).
set "SDK_ENTRY="
call :trynm "!HERE!\node_modules"
if not defined SDK_ENTRY call :trynm "!HERE!\..\app\node_modules"

if not defined SDK_ENTRY (
    echo wf-engine: @anthropic-ai/sdk not found. 1>&2
    echo   Run 'npm install' in !HERE! to make this fully self-contained, 1>&2
    echo   or ensure the cc-wasm install ^(..\app\node_modules^) is present. 1>&2
    exit /b 1
)

set "WF_SDK_PATH=!SDK_ENTRY!"

:: NODE_PATH = two dirname() steps up from SDK_ENTRY
:: (same as the bash: dirname(dirname(SDK_ENTRY)) = the @anthropic-ai scope dir)
for %%F in ("!SDK_ENTRY!\..\..") do set "NM_SCOPE=%%~fF"
if defined NODE_PATH (
    set "NODE_PATH=!NM_SCOPE!;!NODE_PATH!"
) else (
    set "NODE_PATH=!NM_SCOPE!"
)

node "!ENGINE!" %*
goto :eof

:: ----------------------------------------------------------------------------
:trynm
:: Try both index.mjs and index.js in the given node_modules dir (%~1).
for %%E in (index.mjs index.js) do (
    if not defined SDK_ENTRY (
        if exist "%~1\@anthropic-ai\sdk\%%E" (
            set "SDK_ENTRY=%~1\@anthropic-ai\sdk\%%E"
        )
    )
)
goto :eof