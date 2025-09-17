# backtests/urls.py
from django.urls import path
from . import views

urlpatterns = [
    path("", views.home, name="home"),   # <-- usa la función 'home'
]
