import shutil, os
src = os.path.expanduser('~/Library/Application Support/Google/Chrome/Default/Cookies')
shutil.copy(src, '/tmp/c.db')
