from groq import Groq
from limit_retry import retry_on_rate_limit

GROQ_API_KEY = tu tao api key di nha: ))
guide= """
please summary the story
"""


MODELS= ["openai/gpt-oss-120b",
          "openai/gpt-oss-20b"]


class JournalSummariser:
    client= Groq(api_key=GROQ_API_KEY)

    def __init__(self) -> None:
        self.model_id= 0

    @ retry_on_rate_limit()
    def try_summary(self, problem_details: str) -> str:
        chat_completion= self.client.chat.completions.create(
            model=MODELS[self.model_id],
            messages=[
                {
                    "role": "system",
                    "content": guide
                },
                {
                    "role": "user",
                    "content": problem_details,
                },
            ],
            temperature=0,
            max_tokens=1024
        )
        returned_content = chat_completion.choices[0].message.content

        if returned_content is None:
            raise LookupError(
                f"Cannot get the response from {MODELS[self.model_id]}")

        return returned_content

    def swap_model(self) -> None:
        n_models = len(MODELS)
        self.model_id = (self.model_id + 1) % n_models

    def summary(self, problem_details: str, max_loops=5) -> str:
        returned_value = None

        for _ in range(max_loops):
            try:
                returned_value = self.try_summary(problem_details)
                return returned_value
            except Exception as error:
                print(error)
                self.swap_model()

        returned_value = self.try_summary(problem_details)
        return returned_value


print(JournalSummariser().summary(
    "Yesterday i went to school and then i went to another school and then i met my friend and im dumb and i eat rice"))
