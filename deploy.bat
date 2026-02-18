@echo off
set PATH=%PATH%;C:\Program Files\Git\cmd;C:\Program Files\GitHub CLI
cd /d e:\AG\AttendanceSystem\server

echo Pushing updated server to GitHub...
git add -A
git commit -m "Add auth system: register, login, forgot password"
git push origin master

echo.
echo === DONE - Render will auto-deploy ===
