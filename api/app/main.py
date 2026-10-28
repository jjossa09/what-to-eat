from fastapi import FastAPI

app = FastAPI(title="What to eat! API")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
