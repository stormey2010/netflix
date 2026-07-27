"""Invite and connection routes - pairing the two users into a session."""

from fastapi import APIRouter, Depends

from auth import require_api_key
from bus import bus
from schemas import InvitePayload, InviteResponse
from state import state, utcnow, validate_user

router = APIRouter(tags=["invites"], dependencies=[Depends(require_api_key)])


def _publish(event: str, data: dict) -> None:
    bus.publish("invite", {"event": event, **data})


@router.post("/invite/send", response_model=InviteResponse)
def send_invite(payload: InvitePayload) -> InviteResponse:
    try:
        validate_user(payload.from_user)
        validate_user(payload.to_user)
    except ValueError as e:
        return InviteResponse(status="error", message=str(e))
    if payload.from_user == payload.to_user:
        return InviteResponse(status="error", message="Cannot invite yourself")

    state.invite = {
        "from": payload.from_user,
        "to": payload.to_user,
        "created_at": utcnow().isoformat(),
    }
    _publish("invite_received", {"from": payload.from_user, "to": payload.to_user})
    print(f"[INVITE] {payload.from_user} invited {payload.to_user}")
    return InviteResponse(status="pending", invite=state.invite)


@router.post("/invite/accept", response_model=InviteResponse)
def accept_invite(payload: InvitePayload) -> InviteResponse:
    if not state.invite:
        return InviteResponse(status="error", message="No pending invite")
    if state.invite["to"] != payload.from_user or state.invite["from"] != payload.to_user:
        return InviteResponse(status="error", message="Invite mismatch")

    connection = state.set_connection([payload.from_user, payload.to_user])
    _publish("connected", {"users": connection["users"]})
    print(f"[CONNECT] {payload.from_user} and {payload.to_user} connected")
    return InviteResponse(status="connected", connection=connection)


@router.post("/invite/reject", response_model=InviteResponse)
def reject_invite(payload: InvitePayload) -> InviteResponse:
    if not state.invite:
        return InviteResponse(status="error", message="No pending invite")
    if state.invite["to"] != payload.from_user:
        return InviteResponse(status="error", message="Invite mismatch")

    from_user = state.invite["from"]
    state.invite = None
    _publish("rejected", {"from": from_user, "rejected_by": payload.from_user})
    print(f"[INVITE] {payload.from_user} rejected invite")
    return InviteResponse(status="rejected")


@router.get("/invite/status", response_model=InviteResponse)
def invite_status() -> InviteResponse:
    return InviteResponse(
        status="connected" if state.connection else ("pending" if state.invite else "none"),
        invite=state.invite,
        connection=state.connection,
    )


@router.post("/disconnect", response_model=InviteResponse)
def disconnect() -> InviteResponse:
    if state.connection:
        _publish("disconnected", {"users": state.connection.get("users", [])})
        print("[DISCONNECT] Session ended")
    state.clear_connection()
    return InviteResponse(status="disconnected")
