from pathlib import Path
import re

# 从共享样式与交互代码生成四个独立 HTML，避免后续修改遗漏某个入口。
root = Path(__file__).resolve().parent
css = (root / "styles.css").read_text(encoding="utf-8")
app = (root / "china-geo.js").read_text(encoding="utf-8") + "\n" + (root / "app.js").read_text(encoding="utf-8")
for name, title, role in [("boss-mini", "老板小程序", 0), ("staff-mini", "员工小程序", 1), ("boss-web", "老板网页", 2), ("staff-web", "员工网页", 3)]:
    page = root / "pages" / (name + ".html")
    html = page.read_text(encoding="utf-8")
    style = css + "\n#roles, body > header, body > .hint { display:none!important; }\n"
    code = re.sub(r'const initialRole = Number\(.*?\);', "const initialRole = " + str(role) + ";", app, count=1, flags=re.S)
    html = re.sub(r'<style>.*?</style>', lambda _: "<style>\n" + style + "</style>", html, count=1, flags=re.S)
    html = re.sub(r'<script>.*?</script>', lambda _: "<script>\n" + code + "</script>", html, count=1, flags=re.S)
    page.write_text(html, encoding="utf-8")
    print(name + ".html 已同步")
