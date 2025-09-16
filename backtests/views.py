from django.views.generic import TemplateView

class HomeView(TemplateView):
    """
    Vista simple para validar el esqueleto del proyecto.
    Más adelante aquí mostraremos: formulario de backtesting, gráficos y resultados.
    """
    template_name = "backtests/home.html"
