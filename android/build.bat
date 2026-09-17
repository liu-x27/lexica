@echo off
REM Lexica Android build helper.
REM
REM NOTE: keep this file ASCII-only. cmd.exe reads .bat in the system ANSI
REM codepage (GBK here) and mangles UTF-8 comments, which breaks parsing.
REM Chinese notes live in android/README.md instead.
REM
REM The proxy MUST be passed on the command line: the user-level
REM ~/.gradle/gradle.properties pins 127.0.0.1:7897 (nothing listens there;
REM the live proxy is 7890) and user-level properties override project-level
REM ones, so setting it in android/gradle.properties has no effect.

setlocal
set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "GRADLE=%USERPROFILE%\.gradle\wrapper\dists\gradle-8.7-bin\bjduk4ssnbt7bzq0l8cocpo9p\gradle-8.7\bin\gradle.bat"

set "PROXY=-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=7890 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=7890"

REM "%~dp0" ends in a backslash, which would escape the closing quote and
REM corrupt the argument -- the trailing "." keeps the path valid.
call "%GRADLE%" --project-dir "%~dp0." %PROXY% %* --console=plain
endlocal
