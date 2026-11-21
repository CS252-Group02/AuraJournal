"""HTTP-independent rendering using the existing AI pipeline."""
from app.services.pixel_art import build_pixel_art_prompt


def render_pixel_art(state, content, *, before_submit=lambda: None):
    moment = state.moment_extractor.extract(content)
    prompt = build_pixel_art_prompt(moment)
    # Durable callers record submission intent before the potentially billable call.
    before_submit()
    return state.pixellab_client.generate(prompt), moment.kind
