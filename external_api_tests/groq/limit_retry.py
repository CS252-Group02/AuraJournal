import time
import random
import httpx
from functools import wraps

import groq


def retry_on_rate_limit(max_retries=5, fallback_wait=2.0, jitter=0.25):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)

                except groq.RateLimitError as e:
                    print(e)
                    if attempt == max_retries:
                        raise RuntimeError(
                            f"Rate limits exceeded! Retried {max_retries} times without response!")

                    retry_after = None
                    response = getattr(e, "response", None)
                    if response is not None and getattr(response, "headers", None):
                        retry_after = response.headers.get("retry-after")

                    if retry_after is not None:
                        wait = float(retry_after)
                    else:
                        wait = fallback_wait * (2 ** attempt)

                    wait += random.uniform(0, jitter)

                    if wait > 300:
                        raise e

                    time.sleep(wait)

        return wrapper
    return decorator
