@echo off
rem AIM 3D Studio Web: starts the local server and opens the page in your browser.
cd /d "%~dp0"
py -3 serve.py 2>nul || python serve.py
