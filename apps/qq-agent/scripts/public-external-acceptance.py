"""External headless HTTPS acceptance; password stdin only, read-only production browsing."""
import argparse,asyncio,json,sys
from pathlib import Path
from urllib.parse import urlsplit
from playwright.async_api import async_playwright,expect

async def run(origin,proxy,password):
    root=Path(__file__).resolve().parents[1];errors=[];blocked=[]
    summary={'origin':origin,'headless':True,'tls_verification':True,'network':'external macOS browser via existing SOCKS proxy; no hosts override','real_social_calls':0,'viewports':[]}
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,proxy={'server':proxy})
        try:
            for width in (1440,390):
                context=await browser.new_context(viewport={'width':width,'height':950})
                async def boundary(route):
                    request=route.request;u=urlsplit(request.url)
                    if u.scheme+'://'+u.netloc!=origin or (request.method not in ('GET','HEAD') and u.path not in ('/api/login','/api/logout')):
                        blocked.append(u.path);await route.abort();return
                    await route.continue_()
                await context.route('**/*',boundary)
                page=await context.new_page();page.on('pageerror',lambda e:errors.append(type(e).__name__))
                assert (await context.request.get(origin+'/api/config')).status==401
                await page.goto(origin,wait_until='networkidle');await page.locator('#password').fill(password)
                await page.locator('#login-form button').click();await expect(page.locator('#shell')).to_be_visible()
                assert any(c['name']=='qqagent_session' and c['secure'] and c['httpOnly'] for c in await context.cookies())
                state=await (await context.request.get(origin+'/api/status')).json()
                assert state['controls']=={'pause_active':True,'stop_all':True,'social_running':False}
                assert state['persona']['active'] is None
                for target in ('overview','connection','models','persona','friends','qzone','memory','system'):
                    await page.locator('#nav [data-page="'+target+'"]').click();await page.wait_for_timeout(150)
                    assert await page.locator('#main').inner_text()
                assert not await page.evaluate('document.documentElement.scrollWidth>innerWidth')
                await page.locator('#nav [data-page="overview"]').click();await page.wait_for_timeout(150)
                await page.screenshot(path=str(root/'test-results'/('domain-'+str(width)+'.png')),full_page=True)
                await page.locator('#logout').click();await expect(page.locator('#login')).to_be_visible()
                assert (await context.request.get(origin+'/api/status')).status==401
                summary['viewports'].append({'width':width,'pages':8,'login':True,'secure_cookie':True,'logout_invalidated':True,'stop_controls_held':True})
                await context.close()
        finally:await browser.close()
    summary['page_errors']=len(errors);summary['unexpected_requests_blocked']=len(blocked)
    assert not errors and not blocked
    (root/'test-results/domain-browser-summary-20261020.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(summary,ensure_ascii=False))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--url',required=True);parser.add_argument('--proxy',required=True);args=parser.parse_args()
    if not args.url.startswith('https://'):raise SystemExit('URL must use HTTPS')
    password=sys.stdin.read().strip()
    if not password:raise SystemExit('Password required on stdin')
    asyncio.run(run(args.url,args.proxy,password))
