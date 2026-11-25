"""HTTP-independent rendering using the existing AI pipeline."""
from pydantic import ValidationError

from app.services._groq import AIInvalidResponseError, validate_journal_text
from app.services.pixel_art import SignificantMoment, build_pixel_art_prompt, validate_moment_source


def render_pixel_art(state, content, *, before_submit=lambda: None):
    content = validate_journal_text(content)
    try:
        moment = SignificantMoment.model_validate(state.moment_extractor.extract(content))
    except ValidationError:
        raise AIInvalidResponseError("AI service returned an invalid response.") from None
    validate_moment_source(moment, content)
    prompt = build_pixel_art_prompt(moment)
    # Durable callers record submission intent before the potentially billable call.
    before_submit()
    return state.pixellab_client.generate(prompt), moment.kind
