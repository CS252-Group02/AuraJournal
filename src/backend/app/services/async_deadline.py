"""Cancellation-preserving deadlines, including Python 3.10/3.11."""
import asyncio


async def deadline(awaitable, seconds):
    work = asyncio.ensure_future(awaitable)
    try:
        done, _ = await asyncio.wait((work,), timeout=seconds)
        if work not in done:
            raise asyncio.TimeoutError
        return work.result()
    finally:
        work.cancel()
        await asyncio.gather(work, return_exceptions=True)
