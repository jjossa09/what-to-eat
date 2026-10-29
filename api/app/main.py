from fastapi import Depends, FastAPI

from app.auth import current_user

app = FastAPI(title="What to eat! API")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/me")
def me(user_id: str = Depends(current_user)) -> dict[str, str]:
    return {"user_id": user_id}
