"""Dashboard routes - password login and the monitoring UI."""

import hmac
from pathlib import Path

from fastapi import APIRouter, Form, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from auth import SESSION_COOKIE, create_dashboard_token, has_dashboard_session
from config import settings

TEMPLATE_DIR = Path(__file__).parent.parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATE_DIR))

router = APIRouter(tags=["dashboard"])


@router.get("/dashboard", response_class=HTMLResponse)
async def dashboard(request: Request):
    if has_dashboard_session(request):
        return HTMLResponse((TEMPLATE_DIR / "dashboard.html").read_text(encoding="utf-8"))
    return templates.TemplateResponse(
        "dashboard_login.html", {"request": request, "error": None}
    )


@router.post("/dashboard", response_class=HTMLResponse)
async def dashboard_login(request: Request, password: str = Form(...)):
    if hmac.compare_digest(password, settings.dashboard_password):
        token, max_age = create_dashboard_token()
        response = RedirectResponse("/dashboard", status_code=status.HTTP_303_SEE_OTHER)
        response.set_cookie(
            SESSION_COOKIE, token, httponly=True, max_age=max_age, samesite="lax"
        )
        return response
    return templates.TemplateResponse(
        "dashboard_login.html", {"request": request, "error": "Incorrect password"}
    )


@router.get("/dashboard/logout")
async def dashboard_logout():
    response = RedirectResponse("/dashboard", status_code=status.HTTP_303_SEE_OTHER)
    response.delete_cookie(SESSION_COOKIE)
    return response
