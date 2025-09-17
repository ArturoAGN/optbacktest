from django import forms
from datetime import date


class EquityQueryForm(forms.Form):
    ticker = forms.CharField(
        label="Ticker",
        min_length=1,
        max_length=10,
        initial="AAPL",
        widget=forms.TextInput(
            attrs={"placeholder": "AAPL", "class": "input-compact input-ticker"}
        ),
    )

    # Acepta 'YYYY-MM-DD' y 'DD/MM/YYYY' (y 'DD-MM-YYYY')
    DATE_INPUT_FORMATS = ["%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"]

    start_date = forms.DateField(
        label="Desde",
        input_formats=DATE_INPUT_FORMATS,
        widget=forms.DateInput(
            format="%Y-%m-%d",
            attrs={
                "type": "date",
                "class": "input-compact input-date",
                "placeholder": "YYYY-MM-DD",
            },
        ),
    )
    end_date = forms.DateField(
        label="Hasta",
        input_formats=DATE_INPUT_FORMATS,
        widget=forms.DateInput(
            format="%Y-%m-%d",
            attrs={
                "type": "date",
                "class": "input-compact input-date",
                "placeholder": "YYYY-MM-DD",
            },
        ),
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Si no viene nada por GET, fija por defecto:
        # - inicio = primer día del mes en curso
        # - fin = hoy
        if not self.is_bound:
            today = date.today()
            first_of_month = today.replace(day=1)
            self.fields["start_date"].initial = first_of_month
            self.fields["end_date"].initial = today

    def clean(self):
        cleaned = super().clean()
        sd = cleaned.get("start_date")
        ed = cleaned.get("end_date")
        if sd and ed and sd > ed:
            raise forms.ValidationError("La fecha 'Desde' no puede ser posterior a 'Hasta'.")
        return cleaned
