from app.schemas.reflection_chat import Locale, ReflectionSupport, SupportLink, SupportOption


BOUNDARY_COPY = {
    'en': {
        'urgent_support': 'If you or someone else is in immediate danger, contact local emergency services now. If you can, reach out to someone you trust who can stay with you.',
        'professional_support': 'A qualified health professional can help assess what you’re experiencing. You can start with a primary care doctor or a licensed mental health professional.',
        'mood_boundary': 'I’ll leave the name of your mood up to you. What did you notice about how you felt in that moment?',
        'out_of_scope': 'I’m here to help you reflect on your experiences. Is there something that happened that you’d like to think through?',
    },
    'vi': {
        'urgent_support': 'Nếu bạn hoặc người khác đang gặp nguy hiểm ngay lúc này, hãy liên hệ dịch vụ cấp cứu tại địa phương. Nếu có thể, hãy nhờ một người bạn tin tưởng ở bên bạn.',
        'professional_support': 'Chuyên gia y tế có thể giúp bạn đánh giá những gì bạn đang trải qua. Bạn có thể bắt đầu với bác sĩ hoặc chuyên gia sức khỏe tâm thần có giấy phép.',
        'mood_boundary': 'Bạn có thể tự chọn cách gọi tên tâm trạng của mình. Lúc đó, bạn nhận thấy điều gì về cảm xúc của mình?',
        'out_of_scope': 'Mình có thể giúp bạn nhìn lại trải nghiệm của mình. Có chuyện nào đã xảy ra mà bạn muốn suy nghĩ thêm không?',
    },
}

# Versioned list of reviewed directory destinations. Only supported country
# destinations are returned, with the hours and eligibility maintained at source.
URGENT_DIRECTORIES = {'VN': 'https://findahelpline.com/countries/vn'}


def support_for(country: str, locale: Locale) -> ReflectionSupport:
    copy = BOUNDARY_COPY[locale]
    directory = URGENT_DIRECTORIES.get(country)
    label = 'Đường dây hỗ trợ tại Việt Nam' if locale == 'vi' else 'Support helplines in Vietnam'
    return ReflectionSupport(
        country=country,
        locale=locale,
        urgent_support=SupportOption(
            guidance=copy['urgent_support'],
            resources=[SupportLink(label=label, url=directory)] if directory else [],
        ),
        professional_support=SupportOption(guidance=copy['professional_support'], resources=[]),
    )
