@echo off
set PATH=%PATH%;C:\Program Files\Git\cmd;C:\Program Files\GitHub CLI

cd /d e:\AG\AttendanceSystem\server

echo === Step 1: Cleaning old git ===
rmdir /s /q .git 2>nul

echo === Step 2: Git config ===
git config --global user.email "ignisight@users.noreply.github.com"
git config --global user.name "Ignisight"

echo === Step 3: Init and commit ===
git init
git add -A
git commit -m "Attendance server"

echo === Step 4: Create GitHub repo and push ===
gh repo create attendance-server --public --source=. --push

echo.
echo === DONE ===
