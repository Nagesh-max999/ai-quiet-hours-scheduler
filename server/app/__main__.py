"""Production start:  python -m app   (reads HOST / PORT, defaults 0.0.0.0:8000)"""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT") or 8000),
        proxy_headers=True,  # trust X-Forwarded-* from the host's load balancer
        forwarded_allow_ips="*",
    )
